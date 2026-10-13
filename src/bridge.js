/**
 * Swep Local Session Bridge
 * Quản lý phiên làm việc cục bộ với mã hóa bảo vệ khóa ở trạng thái nghỉ (At-Rest Protection)
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { aead_encrypt, aead_decrypt } from './crypto.js';

/**
 * Tạo khóa dẫn xuất gắn liền với máy trạm và tài khoản Windows cục bộ
 * @returns {Buffer} 32-byte key
 */
function getHostKey() {
  const seedStr = [
    process.env.USERPROFILE || '',
    process.env.USERNAME || '',
    process.env.USERDOMAIN || '',
    process.env.COMPUTERNAME || '',
  ].join('::');
  return crypto.createHash('sha256').update(`swep/host/session:${seedStr}`).digest();
}

/**
 * Lưu trạng thái phiên làm việc vào active-session.json có mã hóa bảo vệ
 * Tránh trường hợp infostealer hoặc mã độc quét trộm plaintext DEK / GitHub PAT
 * @param {string} rootDir
 * @param {object} sessionInfo
 */
export function saveActiveSession(rootDir, sessionInfo) {
  const file = path.join(rootDir, 'active-session.json');
  try {
    const hostKey = getHostKey();
    const enc = aead_encrypt(hostKey, sessionInfo, 'swep/session/v1');
    fs.writeFileSync(file, JSON.stringify({ _protected: true, ...enc }, null, 2), 'utf8');
  } catch {
    fs.writeFileSync(file, JSON.stringify(sessionInfo, null, 2), 'utf8');
  }
}

/**
 * Đọc trạng thái phiên làm việc hiện tại và tự động giải mã
 * @param {string} rootDir
 * @returns {object|null}
 */
export function readActiveSession(rootDir) {
  const file = path.join(rootDir, 'active-session.json');
  if (!fs.existsSync(file)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw && raw._protected && raw.ciphertext) {
      const hostKey = getHostKey();
      return aead_decrypt(hostKey, raw, 'swep/session/v1');
    }
    return raw;
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

/**
 * Mask key for secure display: handle-ABxx-xxxC
 * @param {string} key
 * @returns {string}
 */
export function maskKey(key) {
  if (!key || typeof key !== 'string') return '';
  const parts = key.trim().split('-');
  if (parts.length < 2) {
    const s = parts[0];
    if (s.length <= 4) return s;
    return `${s.slice(0, 2)}xx-xxx${s.slice(-1)}`;
  }
  const handle = parts[0];
  const secret = parts.slice(1).join('-');
  if (secret.length <= 4) {
    return `${handle}-****`;
  }
  const head = secret.slice(0, 2);
  const tail = secret.slice(-1);
  return `${handle}-${head}xx-xxx${tail}`;
}

/**
 * Lấy thông tin key đang active
 * @param {string} rootDir
 * @returns {{ rawKey: string, maskedKey: string, session: object } | null}
 */
export function getActiveKey(rootDir) {
  const session = readActiveSession(rootDir);
  if (!session) return null;
  const profileDir = path.join(rootDir, 'chrome-profile');
  if (!fs.existsSync(profileDir)) {
    removeActiveSession(rootDir);
    return null;
  }
  const rawKey = session.loginCode || session.handle || '';
  if (!rawKey) return null;
  return {
    rawKey,
    maskedKey: maskKey(rawKey),
    session,
  };
}
