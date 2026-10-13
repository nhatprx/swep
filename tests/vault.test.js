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

test('vault: checkVaultRepoExists handles 404 gracefully', async () => {
  const { checkVaultRepoExists } = await import('../src/vault.js');
  // Non-existent repo should return false
  const exists = await checkVaultRepoExists('fake_token', 'nhatprx_nonexistent_user', 'swep-vault');
  assert.strictEqual(exists, false);
});

