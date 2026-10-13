/**
 * Swep Profile Capsule Manager
 * Đóng gói, lọc cache, nén gzip, mã hóa AEAD (ChaCha20-Poly1305) toàn bộ Chrome profile
 * và phục hồi nguyên vẹn (Local Storage, IndexedDB, Preferences, Extensions)
 * đồng thời giải quyết triệt để vấn đề Windows DPAPI khi di chuyển giữa các máy khác nhau:
 * - Trích xuất 32-byte AES master key từ Local State qua DPAPI khi đóng gói
 * - Tái mã hóa 32-byte AES master key bằng DPAPI của máy mới khi giải nén
 * -> Đảm bảo Chrome trên máy mới giải mã được 100% SQLite Cookies, Web Data, Login Data!
 */

import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import crypto from 'crypto';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// Magic header định danh Swep Capsule v2
const CAPSULE_MAGIC = Buffer.from('SWEP\x02', 'binary'); // 5 bytes
const AEAD_ALGORITHM = 'chacha20-poly1305';

// Các thư mục rác / cache tạm không cần lưu trữ
const EXCLUDE_DIRS = new Set([
  'Cache',
  'Code Cache',
  'GPUCache',
  'GrShaderCache',
  'ShaderCache',
  'CacheStorage',
  'BrowserMetrics',
  'Crashpad',
  'blob_storage',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'Safe Browsing',
  'component_crx_cache',
  'shared_proto_db',
  'optimization_guide_prediction_model_downloads',
  'optimization_guide_model_metadata',
]);

// Các file lock hoặc tạm thời
const EXCLUDE_FILES = new Set([
  'LOCK',
  'SingletonLock',
  'SingletonCookie',
  'SingletonSocket',
]);

const EXCLUDE_EXTS = new Set([
  '.tmp',
  '.bak',
  '.old',
  '.log',
]);

/**
 * Giải mã DPAPI blob thành plaintext bytes sử dụng CurrentUser scope
 * @param {string} b64ProtectedData
 * @returns {Promise<Buffer|null>}
 */
export async function unprotectDpapi(b64ProtectedData) {
  try {
    const psScript = `
Add-Type -AssemblyName System.Security
$bytes = [Convert]::FromBase64String('${b64ProtectedData}')
$unprotected = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
[Convert]::ToBase64String($unprotected)
`;
    const b64Cmd = Buffer.from(psScript, 'utf16le').toString('base64');
    const { stdout } = await execAsync(`powershell -NoProfile -EncodedCommand ${b64Cmd}`);
    return Buffer.from(stdout.trim(), 'base64');
  } catch {
    return null;
  }
}

/**
 * Mã hóa plaintext bytes bằng DPAPI của máy hiện tại
 * @param {Buffer} rawKeyBuffer
 * @returns {Promise<Buffer|null>}
 */
export async function protectDpapi(rawKeyBuffer) {
  try {
    const b64Raw = rawKeyBuffer.toString('base64');
    const psScript = `
Add-Type -AssemblyName System.Security
$bytes = [Convert]::FromBase64String('${b64Raw}')
$protected = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
[Convert]::ToBase64String($protected)
`;
    const b64Cmd = Buffer.from(psScript, 'utf16le').toString('base64');
    const { stdout } = await execAsync(`powershell -NoProfile -EncodedCommand ${b64Cmd}`);
    return Buffer.from(stdout.trim(), 'base64');
  } catch {
    return null;
  }
}

/**
 * Đóng gói thư mục profile thành buffer nhị phân nén gzip
 * @param {string} profileDir - Đường dẫn thư mục chrome-profile
 * @param {object} [metadata={}] - Metadata bổ sung (session cookies, email...)
 * @returns {Promise<Buffer>} Archive buffer (gzip)
 */
export async function packProfileDirectory(profileDir, metadata = {}) {
  if (!fs.existsSync(profileDir)) {
    throw new Error(`Thư mục profile không tồn tại: ${profileDir}`);
  }

  // Trích xuất 32-byte AES master key từ Local State nếu có để hỗ trợ di chuyển máy khác
  const localStatePath = path.join(profileDir, 'Local State');
  if (fs.existsSync(localStatePath)) {
    try {
      const ls = JSON.parse(fs.readFileSync(localStatePath, 'utf8'));
      const encKeyB64 = ls.os_crypt?.encrypted_key;
      if (encKeyB64) {
        const buf = Buffer.from(encKeyB64, 'base64');
        if (buf.length > 5 && buf.subarray(0, 5).toString('utf8') === 'DPAPI') {
          const dpapiBlob = buf.subarray(5);
          const rawMasterKey = await unprotectDpapi(dpapiBlob.toString('base64'));
          if (rawMasterKey && rawMasterKey.length === 32) {
            metadata.raw_master_key = rawMasterKey.toString('hex');
          }
        }
      }
    } catch {
      // ignore
    }
  }

  const fileEntries = [];

  // Ghi metadata manifest vào đầu archive
  const metaJson = JSON.stringify({
    version: 2,
    timestamp: new Date().toISOString(),
    ...metadata,
  });
  fileEntries.push({
    path: '__swep_manifest__.json',
    isDir: false,
    data: Buffer.from(metaJson, 'utf8'),
  });

  function scan(currentDir, relativePath) {
    let items = [];
    try {
      items = fs.readdirSync(currentDir);
    } catch {
      return;
    }

    for (const item of items) {
      const fullPath = path.join(currentDir, item);
      const relPath = relativePath ? `${relativePath}/${item}` : item;

      // Kiểm tra tên thư mục/file có thuộc danh sách loại trừ không
      if (EXCLUDE_DIRS.has(item) || EXCLUDE_FILES.has(item)) {
        continue;
      }

      const ext = path.extname(item).toLowerCase();
      if (EXCLUDE_EXTS.has(ext)) {
        continue;
      }

      let stat;
      try {
        stat = fs.statSync(fullPath);
      } catch {
        continue;
      }

      if (stat.isDirectory()) {
        fileEntries.push({ path: relPath, isDir: true, data: null });
        scan(fullPath, relPath);
      } else if (stat.isFile()) {
        try {
          const data = fs.readFileSync(fullPath);
          fileEntries.push({ path: relPath, isDir: false, data });
        } catch {
          // Bỏ qua file bị khóa tạm thời
        }
      }
    }
  }

  scan(profileDir, '');

  // Đóng gói format:
  // [count: 4 bytes BE]
  // Mỗi entry: [pathLen: 2 bytes BE] [path: utf8] [isDir: 1 byte] [dataLen: 4 bytes BE] [data]
  const chunks = [];
  const countBuf = Buffer.alloc(4);
  countBuf.writeUInt32BE(fileEntries.length, 0);
  chunks.push(countBuf);

  for (const entry of fileEntries) {
    const pathBuf = Buffer.from(entry.path, 'utf8');
    const header = Buffer.alloc(2 + pathBuf.length + 1 + 4);
    header.writeUInt16BE(pathBuf.length, 0);
    pathBuf.copy(header, 2);
    header.writeUInt8(entry.isDir ? 1 : 0, 2 + pathBuf.length);
    const dataLen = entry.data ? entry.data.length : 0;
    header.writeUInt32BE(dataLen, 3 + pathBuf.length);
    chunks.push(header);
    if (dataLen > 0) {
      chunks.push(entry.data);
    }
  }

  const rawCombined = Buffer.concat(chunks);
  return zlib.gzipSync(rawCombined, { level: 9 });
}

/**
 * Giải nén buffer archive vào thư mục đích
 * @param {Buffer} archiveGzBuffer - Buffer gzip nén
 * @param {string} targetDir - Thư mục đích
 * @returns {{ manifest: object, extractedFiles: number }}
 */
export function unpackProfileDirectory(archiveGzBuffer, targetDir) {
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  const raw = zlib.gunzipSync(archiveGzBuffer);
  let offset = 0;
  const count = raw.readUInt32BE(offset);
  offset += 4;

  let manifest = {};
  let extractedFiles = 0;

  for (let i = 0; i < count; i++) {
    const pathLen = raw.readUInt16BE(offset);
    offset += 2;
    const relPath = raw.toString('utf8', offset, offset + pathLen);
    offset += pathLen;
    const isDir = raw.readUInt8(offset) === 1;
    offset += 1;
    const dataLen = raw.readUInt32BE(offset);
    offset += 4;

    let data = null;
    if (dataLen > 0) {
      data = raw.subarray(offset, offset + dataLen);
      offset += dataLen;
    }

    if (relPath === '__swep_manifest__.json' && data) {
      try {
        manifest = JSON.parse(data.toString('utf8'));
      } catch {
        manifest = {};
      }
      continue;
    }

    const destPath = path.join(targetDir, relPath);
    if (isDir) {
      if (!fs.existsSync(destPath)) {
        fs.mkdirSync(destPath, { recursive: true });
      }
    } else {
      const parent = path.dirname(destPath);
      if (!fs.existsSync(parent)) {
        fs.mkdirSync(parent, { recursive: true });
      }
      if (data) {
        fs.writeFileSync(destPath, data);
        extractedFiles++;
      }
    }
  }

  return { manifest, extractedFiles };
}

/**
 * Thích ứng Profile với DPAPI của máy hiện tại:
 * Tái mã hóa 32-byte AES master key bằng DPAPI của máy đích và ghi vào Local State.
 * Giữ nguyên 100% dữ liệu SQLite Cookies, Local Storage, IndexedDB, Preferences.
 * @param {string} profileDir
 * @param {object} manifest
 */
export async function adaptProfileForCurrentMachine(profileDir, manifest = {}) {
  const localStatePath = path.join(profileDir, 'Local State');
  if (manifest.raw_master_key && fs.existsSync(localStatePath)) {
    try {
      const rawKey = Buffer.from(manifest.raw_master_key, 'hex');
      const protectedBlob = await protectDpapi(rawKey);
      if (protectedBlob && protectedBlob.length > 0) {
        const ls = JSON.parse(fs.readFileSync(localStatePath, 'utf8'));
        const newEncKeyB64 = Buffer.concat([Buffer.from('DPAPI'), protectedBlob]).toString('base64');
        ls.os_crypt = ls.os_crypt || {};
        ls.os_crypt.encrypted_key = newEncKeyB64;
        fs.writeFileSync(localStatePath, JSON.stringify(ls, null, 2), 'utf8');
      }
    } catch {
      // ignore
    }
  }
}

/**
 * Mã hóa Profile Capsule bằng AEAD (ChaCha20-Poly1305)
 * Header format: [SWEP\x02: 5B] [Nonce: 12B] [Tag: 16B] [Ciphertext]
 * @param {Buffer} rawGzBuffer - Buffer gzip nén
 * @param {Buffer} dek - Data Encryption Key 32 byte
 * @param {string} [aad=''] - Associated Authenticated Data
 * @returns {Buffer} Encrypted binary capsule
 */
export function encryptCapsule(rawGzBuffer, dek, aad = 'swep/capsule/v2') {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(AEAD_ALGORITHM, dek, nonce);
  if (aad) {
    cipher.setAAD(Buffer.from(aad, 'utf8'));
  }

  const ciphertext = Buffer.concat([cipher.update(rawGzBuffer), cipher.final()]);
  const tag = cipher.getAuthTag();

  return Buffer.concat([
    CAPSULE_MAGIC,
    nonce,
    tag,
    ciphertext,
  ]);
}

/**
 * Xác thực Poly1305 và giải mã Profile Capsule
 * @param {Buffer} encBuffer - Encrypted binary capsule
 * @param {Buffer} dek - Data Encryption Key 32 byte
 * @param {string} [aad=''] - Associated Authenticated Data
 * @returns {Buffer} Decrypted raw gzip buffer
 */
export function decryptCapsule(encBuffer, dek, aad = 'swep/capsule/v2') {
  if (!Buffer.isBuffer(encBuffer) || encBuffer.length < CAPSULE_MAGIC.length + 12 + 16) {
    throw new Error('Dữ liệu capsule không hợp lệ hoặc quá ngắn.');
  }

  // Kiểm tra magic header
  const magic = encBuffer.subarray(0, CAPSULE_MAGIC.length);
  if (!magic.equals(CAPSULE_MAGIC)) {
    throw new Error('Định dạng Capsule không khớp (thiếu chữ ký SWEP v2).');
  }

  let offset = CAPSULE_MAGIC.length;
  const nonce = encBuffer.subarray(offset, offset + 12);
  offset += 12;
  const tag = encBuffer.subarray(offset, offset + 16);
  offset += 16;
  const ciphertext = encBuffer.subarray(offset);

  const decipher = crypto.createDecipheriv(AEAD_ALGORITHM, dek, nonce);
  if (aad) {
    decipher.setAAD(Buffer.from(aad, 'utf8'));
  }
  decipher.setAuthTag(tag);

  try {
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return decrypted;
  } catch (err) {
    throw new Error(`Xác thực tính toàn vẹn capsule thất bại (Poly1305 Auth Tag mismatch): ${err.message}`);
  }
}
