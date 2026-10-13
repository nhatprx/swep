/**
 * Test: Vault storage and Zero-Server encryption flow
 */

import { test } from 'node:test';
import assert from 'node:assert';
import {
  generateDEK,
  generateCode,
  normalizeCode,
  deriveSeed,
  hkdf,
  aead_encrypt,
  aead_decrypt,
} from '../src/crypto.js';

test('vault: zero-server encryption and decryption flow', async () => {
  const handle = 'testuser';
  const rawCode = generateCode(10);
  const normalizedCode = normalizeCode(rawCode);

  const dek = generateDEK();
  const rawPayload = {
    google_email: 'mywork@gmail.com',
    google_password: 'superSecretPassword',
    totp_secret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
    version: 1,
  };

  // Mã hóa payload bằng DEK
  const encryptedPayload = aead_encrypt(dek, rawPayload, `${handle}/1`);

  // Bọc DEK bằng codeKey
  const seed = await deriveSeed(normalizedCode, handle);
  const codeKey = hkdf(seed, 'swep/wrap');
  const wrapCode = aead_encrypt(codeKey, { dek: dek.toString('hex') }, `${handle}/code`);

  // Giả lập vault.json lưu trên GitHub
  const vaultJson = {
    handle,
    version: 1,
    wrap_code: wrapCode,
    payload: encryptedPayload,
  };

  // Giả lập máy mượn đọc vaultJson và giải mã
  const clientSeed = await deriveSeed(normalizedCode, handle);
  const clientCodeKey = hkdf(clientSeed, 'swep/wrap');

  const decryptedDekObj = aead_decrypt(clientCodeKey, vaultJson.wrap_code, `${handle}/code`);
  const decryptedDek = Buffer.from(decryptedDekObj.dek, 'hex');

  const decryptedPayload = aead_decrypt(decryptedDek, vaultJson.payload, `${handle}/1`);

  assert.strictEqual(decryptedPayload.google_email, 'mywork@gmail.com');
  assert.strictEqual(decryptedPayload.google_password, 'superSecretPassword');
});

test('vault: distributed session concurrency lock and lease expiration', async () => {
  const { checkSessionLock, createSessionLockData, createReleaseLockData } = await import('../src/vault.js');

  // 1. Initial state: No lock
  const vaultEmpty = { handle: 'alice' };
  assert.deepStrictEqual(checkSessionLock(vaultEmpty), { locked: false, isStale: false, lock: null });

  // 2. Active lock on Machine A
  const lockA = createSessionLockData('Machine-A', 5000); // 5 seconds TTL
  const vaultLocked = { handle: 'alice', lock: lockA };
  const statusActive = checkSessionLock(vaultLocked);
  assert.strictEqual(statusActive.locked, true);
  assert.strictEqual(statusActive.isStale, false);
  assert.strictEqual(statusActive.lock.holder, 'Machine-A');

  // 3. Released lock (after swep down)
  const lockReleased = createReleaseLockData();
  const vaultReleased = { handle: 'alice', lock: lockReleased };
  const statusReleased = checkSessionLock(vaultReleased);
  assert.strictEqual(statusReleased.locked, false);

  // 4. Stale/Expired lock (after crash/timeout)
  const expiredLock = {
    active: true,
    holder: 'Dead-Machine',
    locked_at: new Date(Date.now() - 600000).toISOString(),
    expires_at: new Date(Date.now() - 1000).toISOString(),
  };
  const vaultExpired = { handle: 'alice', lock: expiredLock };
  const statusExpired = checkSessionLock(vaultExpired);
  assert.strictEqual(statusExpired.locked, false);
  assert.strictEqual(statusExpired.isStale, true);
  assert.strictEqual(statusExpired.lock.holder, 'Dead-Machine');
});
