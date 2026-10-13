/**
 * Crypto utilities: argon2, HKDF, AEAD, TOTP
 * 
 * Phần này cần nhất sự cẩn thận. Không tự nghĩ ra thuật toán mới:
 * chỉ ghép các primitive chuẩn.
 */

import crypto from 'crypto';
import argon2 from 'argon2';

// Constants
const HKDF_ALGORITHM = 'sha256';
const AEAD_ALGORITHM = 'chacha20-poly1305'; // Node 15.7.0+
const ARGON2_PARAMS = {
  memoryCost: 65536, // 64 MiB
  timeCost: 3,
  parallelism: 4,
  type: argon2.argon2id,
  raw: true,
};

const CROCKFORD_BASE32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // 32 chars (10 digits + 22 letters, no I/L/O/U)

/**
 * Dẫn xuất khóa từ mã 6 ký tự bằng Argon2id
 * @param {string} code - Mã đăng nhập (6 ký tự)
 * @param {string} handle - GitHub username
 * @returns {Promise<Buffer>} Seed (32 byte)
 */
export async function deriveSeed(code, handle) {
  const salt = crypto
    .createHash('sha256')
    .update(`swep/v1/${handle}`)
    .digest();

  return argon2.hash(code, {
    ...ARGON2_PARAMS,
    salt,
  });
}

/**
 * HKDF để tạo hai khóa độc lập từ seed
 * @param {Buffer} seed - Seed 32 byte
 * @param {string} info - Context string (ví dụ: "swep/auth", "swep/wrap")
 * @returns {Buffer} 32-byte key Buffer
 */
export function hkdf(seed, info) {
  return Buffer.from(
    crypto.hkdfSync(HKDF_ALGORITHM, seed, Buffer.alloc(0), info, 32)
  );
}

/**
 * Mã hóa dữ liệu bằng AEAD (ChaCha20-Poly1305)
 * @param {Buffer} key - Encryption key (32 byte)
 * @param {object|string|Buffer} data - Data to encrypt
 * @param {Buffer|string} [aad] - Associated authenticated data (handle + version)
 * @returns {{ nonce: string, ciphertext: string, tag: string }}
 */
export function aead_encrypt(key, data, aad = '') {
  const nonce = crypto.randomBytes(12); // 96-bit for ChaCha20-Poly1305
  const dataStr = typeof data === 'string'
    ? data
    : Buffer.isBuffer(data)
      ? data.toString('utf8')
      : JSON.stringify(data);

  const cipher = crypto.createCipheriv(AEAD_ALGORITHM, key, nonce);
  if (aad) {
    cipher.setAAD(typeof aad === 'string' ? Buffer.from(aad) : aad);
  }

  let ciphertext = cipher.update(dataStr, 'utf8', 'hex');
  ciphertext += cipher.final('hex');

  const tag = cipher.getAuthTag();

  return {
    nonce: nonce.toString('hex'),
    ciphertext,
    tag: tag.toString('hex'),
  };
}

/**
 * Giải mã AEAD
 * @param {Buffer} key - Decryption key (32 byte)
 * @param {{ nonce: string, ciphertext: string, tag: string }} encrypted
 * @param {Buffer|string} [aad] - Associated authenticated data
 * @returns {any} Decrypted data
 */
export function aead_decrypt(key, encrypted, aad = '') {
  const nonce = Buffer.from(encrypted.nonce, 'hex');
  const ciphertext = Buffer.from(encrypted.ciphertext, 'hex');
  const tag = Buffer.from(encrypted.tag, 'hex');

  const decipher = crypto.createDecipheriv(AEAD_ALGORITHM, key, nonce);
  if (aad) {
    decipher.setAAD(typeof aad === 'string' ? Buffer.from(aad) : aad);
  }
  decipher.setAuthTag(tag);

  let plaintext = decipher.update(ciphertext, 'hex', 'utf8');
  plaintext += decipher.final('utf8');

  try {
    return JSON.parse(plaintext);
  } catch {
    return plaintext;
  }
}

/**
 * Tính TOTP (RFC 6238) cho Google Authenticator
 * @param {string} secret - TOTP secret (base32)
 * @param {number} [timeStep] - Thời gian (giây)
 * @returns {string} 6-digit TOTP code
 */
export function getTOTP(secret, timeStep = Math.floor(Date.now() / 1000)) {
  const secretBuffer = base32Decode(secret);

  const counter = Math.floor(timeStep / 30);
  const buf = Buffer.allocUnsafe(8);
  buf.writeBigUInt64BE(BigInt(counter));

  const hmac = crypto.createHmac('sha1', secretBuffer);
  hmac.update(buf);
  const digest = hmac.digest();

  const offset = digest[digest.length - 1] & 0x0f;
  const code = digest.readUInt32BE(offset) & 0x7fffffff;

  return String(code % 1000000).padStart(6, '0');
}

/**
 * Sinh mã đăng nhập ngẫu nhiên từ Crockford base32 (30 bit entropy)
 * @param {number} [length=6] - Số ký tự
 * @returns {string} Mã (ví dụ: "ABC-DEF")
 */
export function generateCode(length = 6) {
  let code = '';
  for (let i = 0; i < length; i++) {
    code += CROCKFORD_BASE32[crypto.randomInt(0, 32)];
  }
  if (length === 6) {
    return `${code.slice(0, 3)}-${code.slice(3)}`;
  }
  return code;
}

/**
 * Chuẩn hóa mã: bỏ gạch ngang, hóa chữ hoa, fix O→0, I/L→1
 * @param {string} code - Mã đầu vào
 * @returns {string} Mã chuẩn hóa
 */
export function normalizeCode(code) {
  return code
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
}

/**
 * Sinh khóa dữ liệu ngẫu nhiên (DEK - Data Encryption Key) 32 byte
 * @returns {Buffer}
 */
export function generateDEK() {
  return crypto.randomBytes(32);
}

/**
 * Sinh Recovery Key 128 bit ngẫu nhiên (dạng 4F8Q-2P9K-L7R3-M5X8)
 * @returns {string}
 */
export function generateRecoveryKey() {
  const chars = CROCKFORD_BASE32;
  const groups = [];
  for (let g = 0; g < 4; g++) {
    let group = '';
    for (let i = 0; i < 4; i++) {
      group += chars[crypto.randomInt(0, 32)];
    }
    groups.push(group);
  }
  return groups.join('-');
}

/**
 * Dẫn xuất recovery_key thành key 32-byte bằng HKDF
 * @param {string} recoveryKey
 * @returns {Buffer}
 */
export function deriveRecoveryKeyBuffer(recoveryKey) {
  const normalized = normalizeCode(recoveryKey);
  const salt = crypto.createHash('sha256').update('swep/v1/recovery').digest();
  return Buffer.from(
    crypto.hkdfSync('sha256', Buffer.from(normalized), salt, 'swep/recovery/wrap', 32)
  );
}

/**
 * Tính recovery_auth dùng cho API so khớp
 * @param {string} recoveryKey
 * @returns {string} hex hash
 */
export function deriveRecoveryAuth(recoveryKey) {
  const normalized = normalizeCode(recoveryKey);
  return crypto.createHash('sha256').update(`swep/recovery/auth:${normalized}`).digest('hex');
}

/**
 * So sánh an toàn thời gian hằng số (timing safe)
 * @param {string|Buffer} a
 * @param {string|Buffer} b
 * @returns {boolean}
 */
export function timingSafeEqual(a, b) {
  const bufA = Buffer.isBuffer(a) ? a : Buffer.from(a);
  const bufB = Buffer.isBuffer(b) ? b : Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Base32 decode (chuẩn RFC 4648)
 * @param {string} str - Base32 string
 * @returns {Buffer} Decoded bytes
 */
function base32Decode(str) {
  const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const cleanStr = (str || '').replace(/=+$/, '').toUpperCase().replace(/\s+/g, '');
  const bits = cleanStr
    .split('')
    .map((c) => {
      const idx = ALPHABET.indexOf(c);
      if (idx === -1) throw new Error(`Invalid base32 char: ${c}`);
      return idx.toString(2).padStart(5, '0');
    })
    .join('');

  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }

  return Buffer.from(bytes);
}

export { CROCKFORD_BASE32 };
