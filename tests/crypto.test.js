/**
 * Test: Crypto utilities
 * Unit test cho argon2, HKDF, AEAD, TOTP, Recovery key
 */

import { test } from 'node:test';
import assert from 'node:assert';
import {
  deriveSeed,
  hkdf,
  aead_encrypt,
  aead_decrypt,
  getTOTP,
  generateCode,
  normalizeCode,
  generateDEK,
  generateRecoveryKey,
  deriveRecoveryKeyBuffer,
  deriveRecoveryAuth,
  timingSafeEqual,
} from '../src/crypto.js';

test('crypto: derive seed từ code', async () => {
  const code = 'ABC123';
  const handle = 'testuser';

  const seed1 = await deriveSeed(code, handle);
  const seed2 = await deriveSeed(code, handle);

  // Cùng input → cùng output (deterministic)
  assert.deepStrictEqual(seed1, seed2);
  assert.strictEqual(seed1.length, 32);
});

test('crypto: HKDF tạo khóa độc lập', () => {
  const seed = Buffer.alloc(32, 1);

  const authKey = hkdf(seed, 'swep/auth');
  const wrapKey = hkdf(seed, 'swep/wrap');

  // Hai khóa khác nhau
  assert.notDeepStrictEqual(authKey, wrapKey);
  assert.strictEqual(authKey.length, 32);
  assert.strictEqual(wrapKey.length, 32);
});

test('crypto: AEAD encrypt/decrypt', () => {
  const key = Buffer.alloc(32, 1);
  const data = { email: 'test@gmail.com', password: 'secret' };
  const aad = 'testuser/v1';

  const encrypted = aead_encrypt(key, data, aad);
  const decrypted = aead_decrypt(key, encrypted, aad);

  assert.deepStrictEqual(decrypted, data);
});

test('crypto: generateCode', () => {
  const code = generateCode(6);
  assert.match(code, /^[0-9A-Z]{3}-[0-9A-Z]{3}$/);
});

test('crypto: normalizeCode', () => {
  const normalized = normalizeCode('O-i-l');
  assert.strictEqual(normalized, '011');
});

test('crypto: getTOTP RFC 6238 test vector', () => {
  // RFC 6238 test vector: secret "12345678901234567890" = base32 "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"
  const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  const totp1 = getTOTP(secret, 59);
  assert.strictEqual(totp1, '287082');

  const totp2 = getTOTP(secret, 1111111111);
  assert.strictEqual(totp2, '050471');
});

test('crypto: DEK and Recovery Key', () => {
  const dek = generateDEK();
  assert.strictEqual(dek.length, 32);

  const recoveryKey = generateRecoveryKey();
  assert.match(recoveryKey, /^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);

  const recoveryKeyBuf = deriveRecoveryKeyBuffer(recoveryKey);
  assert.strictEqual(recoveryKeyBuf.length, 32);

  const recoveryAuth = deriveRecoveryAuth(recoveryKey);
  assert.strictEqual(typeof recoveryAuth, 'string');
  assert.strictEqual(recoveryAuth.length, 64);

  // Wrap DEK with recoveryKeyBuf and unwrap
  const wrapped = aead_encrypt(recoveryKeyBuf, { dek: dek.toString('hex') }, 'testuser/recovery');
  const unwrapped = aead_decrypt(recoveryKeyBuf, wrapped, 'testuser/recovery');
  assert.strictEqual(unwrapped.dek, dek.toString('hex'));
});

test('crypto: timingSafeEqual', () => {
  assert.strictEqual(timingSafeEqual('abcdef', 'abcdef'), true);
  assert.strictEqual(timingSafeEqual('abcdef', 'abcdeg'), false);
  assert.strictEqual(timingSafeEqual('abcdef', 'abc'), false);
});
