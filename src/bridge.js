/**
 * Swep Local Session Bridge
 * Máy chủ HTTP nhẹ tại 127.0.0.1 làm cầu nối truyền nhận cookies hai chiều
 * giữa Swep CLI và Chrome Extension
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Khởi động Session Bridge Server trên 127.0.0.1
 * @param {Array} [initialCookies=[]]
 * @returns {Promise<{
 *   port: number,
 *   server: http.Server,
 *   getLatestCookies: () => Array,
 *   setLatestCookies: (c: Array) => void,
 *   waitForInjection: (timeoutMs?: number) => Promise<boolean>,
 *   close: () => Promise<void>
 * }>}
 */
export function startBridge(initialCookies = []) {
  return new Promise((resolve, reject) => {
    let latestCookies = Array.isArray(initialCookies) ? [...initialCookies] : [];
    let injectedResolver = null;
    const injectedPromise = new Promise((res) => {
      injectedResolver = res;
    });

    const server = http.createServer((req, res) => {
      // CORS cho extension
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      const url = req.url || '/';

      if (req.method === 'GET' && url === '/session') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ cookies: latestCookies }));
        return;
      }

      if (req.method === 'POST' && url === '/injected') {
        if (injectedResolver) injectedResolver(true);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
        return;
      }

      if (req.method === 'POST' && url === '/sync') {
        let body = '';
        req.on('data', (chunk) => {
          body += chunk;
        });
        req.on('end', () => {
          try {
            const data = JSON.parse(body);
            if (Array.isArray(data.cookies) && data.cookies.length) {
              latestCookies = data.cookies;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'ok', count: latestCookies.length }));
          } catch {
            res.writeHead(400);
            res.end();
          }
        });
        return;
      }

      if (req.method === 'GET' && url === '/latest') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ cookies: latestCookies }));
        return;
      }

      res.writeHead(404);
      res.end();
    });

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        port,
        server,
        getLatestCookies: () => latestCookies,
        setLatestCookies: (c) => {
          latestCookies = c;
        },
        waitForInjection: (timeoutMs = 10000) => {
          if (!latestCookies.length) return Promise.resolve(true);
          return Promise.race([
            injectedPromise,
            new Promise((r) => setTimeout(() => r(false), timeoutMs)),
          ]);
        },
        close: () =>
          new Promise((closeRes) => {
            server.close(() => closeRes());
          }),
      });
    });

    server.on('error', (err) => {
      reject(err);
    });
  });
}

/**
 * Chuẩn bị thư mục extension sẵn sàng để nạp vào Chrome
 * @param {string} rootDir - Thư mục gốc Swep (%LOCALAPPDATA%\Swep)
 * @param {number} port - Cổng bridge server
 * @param {string} [targetUrl]
 * @returns {string} Đường dẫn thư mục extension
 */
export function prepareExtensionDir(rootDir, port, targetUrl = 'https://accounts.google.com') {
  const extensionDest = path.join(rootDir, 'extension');
  if (!fs.existsSync(extensionDest)) {
    fs.mkdirSync(extensionDest, { recursive: true });
  }

  const srcExtension = path.join(__dirname, 'extension');

  // Copy manifest.json và background.js
  const manifestSrc = path.join(srcExtension, 'manifest.json');
  const bgSrc = path.join(srcExtension, 'background.js');

  fs.copyFileSync(manifestSrc, path.join(extensionDest, 'manifest.json'));
  fs.copyFileSync(bgSrc, path.join(extensionDest, 'background.js'));

  // Ghi file config.json cho extension
  const config = {
    port,
    targetUrl,
  };
  fs.writeFileSync(path.join(extensionDest, 'config.json'), JSON.stringify(config, null, 2), 'utf8');

  return extensionDest;
}

/**
 * Lưu trạng thái phiên làm việc hiện tại vào file active-session.json
 * @param {string} rootDir
 * @param {object} sessionInfo
 */
export function saveActiveSession(rootDir, sessionInfo) {
  const file = path.join(rootDir, 'active-session.json');
  fs.writeFileSync(file, JSON.stringify(sessionInfo, null, 2), 'utf8');
}

/**
 * Đọc trạng thái phiên làm việc hiện tại
 * @param {string} rootDir
 * @returns {object|null}
 */
export function readActiveSession(rootDir) {
  const file = path.join(rootDir, 'active-session.json');
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Xóa trạng thái phiên làm việc
 * @param {string} rootDir
 */
export function removeActiveSession(rootDir) {
  const file = path.join(rootDir, 'active-session.json');
  try {
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } catch {
    // ignore
  }
}
