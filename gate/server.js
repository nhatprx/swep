/**
 * Swep Gate - Server Implementation
 * Triển khai các API endpoints theo docs/SPEC.md
 * Có thể chạy local (development/mock) hoặc trên Vercel / Docker
 */

import http from 'http';
import crypto from 'crypto';
import { URL } from 'url';

const PORT = process.env.PORT || 3000;
const PEPPER = process.env.PEPPER || 'swep-dev-pepper-secret-must-be-long';
const _SERVER_KEY = process.env.SERVER_KEY || '01234567890123456789012345678901'; // 32 bytes envelope key

// In-memory Database (Postgres simulation)
const users = new Map(); // handle -> User
const sessions = new Map(); // sessionId -> Session
const failedAttempts = new Map(); // handle -> { count, lockedUntil }

/**
 * Tính HMAC-SHA256 với PEPPER
 */
function computeAuthHash(authKeyHex) {
  return crypto.createHmac('sha256', PEPPER).update(authKeyHex).digest('hex');
}

/**
 * So sánh an toàn thời gian hằng số
 */
function timingSafeEqual(a, b) {
  if (!a || !b) return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Đọc JSON body từ request
 */
async function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1e6) {
        req.destroy();
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * Gửi JSON response
 */
function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  });
  res.end(JSON.stringify(data));
}

export function createGateServer() {
  return http.createServer(async (req, res) => {
    // CORS Preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      });
      res.end();
      return;
    }

    const reqUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = reqUrl.pathname;

    try {
      // 1. Health check
      if (pathname === '/api/health' && req.method === 'GET') {
        sendJson(res, 200, { status: 'ok', service: 'swep-gate', time: new Date().toISOString() });
        return;
      }

      // Chỉ xử lý POST cho các API sau
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'Method not allowed' });
        return;
      }

      const body = await parseJsonBody(req);

      // 2. POST /api/register
      if (pathname === '/api/register') {
        const { handle, google_email, auth_hash, wrap_code, wrap_recovery, payload } = body;
        if (!handle || !auth_hash || !wrap_code || !payload) {
          sendJson(res, 400, { error: 'Missing required fields' });
          return;
        }

        const normalizedHandle = handle.toLowerCase();
        if (users.has(normalizedHandle)) {
          sendJson(res, 409, { error: 'Handle đã tồn tại' });
          return;
        }

        const serverAuthHash = computeAuthHash(auth_hash);

        const newUser = {
          handle: normalizedHandle,
          google_email,
          auth_hash: serverAuthHash,
          wrap_code,
          wrap_recovery,
          recovery_auth: body.recovery_auth || null,
          payload,
          pending_auth_hash: null,
          pending_wrap_code: null,
          pending_at: null,
          created_at: new Date().toISOString(),
          last_login_at: null,
          revoked_at: null,
          failed_count: 0,
        };

        users.set(normalizedHandle, newUser);
        sendJson(res, 200, {
          status: 'ok',
          handle: normalizedHandle,
          created_at: newUser.created_at,
        });
        return;
      }

      // 3. POST /api/login
      if (pathname === '/api/login') {
        const { handle, auth_key } = body;
        if (!handle || !auth_key) {
          sendJson(res, 400, { error: 'Missing handle or auth_key' });
          return;
        }

        const normalizedHandle = handle.toLowerCase();
        const user = users.get(normalizedHandle);

        // Chống timing attack & kiểm tra tài khoản
        const submittedHash = computeAuthHash(auth_key);
        const userHash = user?.auth_hash || '0'.repeat(64);
        const isMatch = timingSafeEqual(submittedHash, userHash) && !!user;

        if (user?.revoked_at) {
          sendJson(res, 410, { error: 'Tài khoản đã bị revoke. Hãy dùng swep recover.' });
          return;
        }

        if (!isMatch) {
          // Ghi nhận lần sai
          const attempts = failedAttempts.get(normalizedHandle) || { count: 0, lockedUntil: null };
          attempts.count += 1;
          failedAttempts.set(normalizedHandle, attempts);

          sendJson(res, 401, { error: 'Mã hoặc tên đăng nhập không đúng' });
          return;
        }

        // Đăng nhập thành công -> Tạo session
        const sessionId = `sess_${crypto.randomBytes(24).toString('hex')}`;
        const session = {
          id: sessionId,
          handle: normalizedHandle,
          expires_at: Date.now() + 10 * 60 * 1000, // 10 phút
        };
        sessions.set(sessionId, session);

        user.last_login_at = new Date().toISOString();
        const failedCount = failedAttempts.get(normalizedHandle)?.count || 0;
        failedAttempts.delete(normalizedHandle);

        sendJson(res, 200, {
          status: 'ok',
          session: sessionId,
          payload: user.payload,
          wrap_code: user.wrap_code,
          notices: {
            failed_count: failedCount,
            last_login_at: user.last_login_at,
          },
        });
        return;
      }

      // 4. POST /api/rotate/stage
      if (pathname === '/api/rotate/stage') {
        const { session: sessionId, auth_hash, wrap_code } = body;
        const session = sessions.get(sessionId);
        if (!session || session.expires_at < Date.now()) {
          sendJson(res, 401, { error: 'Session không hợp lệ hoặc đã hết hạn' });
          return;
        }

        const user = users.get(session.handle);
        if (!user) {
          sendJson(res, 404, { error: 'Không tìm thấy người dùng' });
          return;
        }

        user.pending_auth_hash = computeAuthHash(auth_hash);
        user.pending_wrap_code = wrap_code;
        user.pending_at = Date.now();

        sendJson(res, 200, {
          status: 'ok',
          message: 'Mã chờ đã lưu. Vui lòng nhập lại để xác nhận.',
        });
        return;
      }

      // 5. POST /api/rotate/confirm
      if (pathname === '/api/rotate/confirm') {
        const { session: sessionId } = body;
        const session = sessions.get(sessionId);
        if (!session || session.expires_at < Date.now()) {
          sendJson(res, 401, { error: 'Session không hợp lệ hoặc đã hết hạn' });
          return;
        }

        const user = users.get(session.handle);
        if (!user || !user.pending_auth_hash) {
          sendJson(res, 400, { error: 'Không có mã chờ nào để xác nhận' });
          return;
        }

        // Thăng cấp mã mới
        user.auth_hash = user.pending_auth_hash;
        user.wrap_code = user.pending_wrap_code;
        user.pending_auth_hash = null;
        user.pending_wrap_code = null;
        user.pending_at = null;

        sendJson(res, 200, {
          status: 'ok',
          message: 'Mã đã được xác nhận. Mã cũ hết hiệu lực.',
        });
        return;
      }

      // 6. POST /api/payload
      if (pathname === '/api/payload') {
        const { session: sessionId, payload } = body;
        const session = sessions.get(sessionId);
        if (!session) {
          sendJson(res, 401, { error: 'Session không hợp lệ' });
          return;
        }

        const user = users.get(session.handle);
        if (user) {
          user.payload = payload;
        }

        sendJson(res, 200, { status: 'ok' });
        return;
      }

      // 7. POST /api/recover
      if (pathname === '/api/recover') {
        const { handle, recovery_auth } = body;
        const normalizedHandle = (handle || '').toLowerCase();
        const user = users.get(normalizedHandle);

        if (!user) {
          sendJson(res, 404, { error: 'Người dùng không tồn tại' });
          return;
        }

        if (user.recovery_auth && recovery_auth && !timingSafeEqual(user.recovery_auth, recovery_auth)) {
          sendJson(res, 401, { error: 'Khóa khôi phục không khớp' });
          return;
        }

        sendJson(res, 200, {
          status: 'ok',
          payload: user.payload,
          wrap_recovery: user.wrap_recovery,
        });
        return;
      }

      // 8. POST /api/recover/finish
      if (pathname === '/api/recover/finish') {
        const { handle, auth_hash, wrap_code, payload } = body;
        const normalizedHandle = (handle || '').toLowerCase();
        const user = users.get(normalizedHandle);

        if (!user) {
          sendJson(res, 404, { error: 'Người dùng không tồn tại' });
          return;
        }

        user.auth_hash = computeAuthHash(auth_hash);
        user.wrap_code = wrap_code;
        if (payload) user.payload = payload;
        user.revoked_at = null;

        sendJson(res, 200, {
          status: 'ok',
          message: 'Khôi phục tài khoản thành công',
        });
        return;
      }

      // 9. POST /api/revoke
      if (pathname === '/api/revoke') {
        for (const user of users.values()) {
          user.revoked_at = new Date().toISOString();
          user.auth_hash = 'revoked';
        }
        sendJson(res, 200, {
          status: 'ok',
          message: 'Mọi mã đã bị vô hiệu hóa.',
        });
        return;
      }

      sendJson(res, 404, { error: 'Not found' });
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
  });
}

// Nếu chạy trực tiếp: node gate/server.js
if (process.argv[1] && process.argv[1].endsWith('server.js')) {
  const server = createGateServer();
  server.listen(PORT, () => {
    console.log(`⚡ Swep Gate Server đang chạy tại http://localhost:${PORT}`);
  });
}
