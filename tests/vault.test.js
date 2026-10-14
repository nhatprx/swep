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

test('vault: recovery key decrypts DEK and regenerates wrap_code with random salt', async () => {
  const { generateRecoveryKey, deriveRecoveryKeyBuffer } = await import('../src/crypto.js');
  const handle = 'recoveryuser';
  const dek = generateDEK();

  const recoveryKey = generateRecoveryKey();
  const recoveryKeyBuf = deriveRecoveryKeyBuffer(recoveryKey);
  const wrapRecovery = aead_encrypt(recoveryKeyBuf, { dek: dek.toString('hex') }, `${handle}/recovery`);

  // Recover DEK
  const recoveredDekObj = aead_decrypt(recoveryKeyBuf, wrapRecovery, `${handle}/recovery`);
  assert.strictEqual(recoveredDekObj.dek, dek.toString('hex'));

  // Generate new code with random salt
  const cryptoModule = await import('crypto');
  const randomSalt = cryptoModule.default.randomBytes(16);
  const newCode = generateCode(10);
  const seed = await deriveSeed(normalizeCode(newCode), handle, randomSalt);
  const codeKey = hkdf(seed, 'swep/wrap');
  const newWrapCode = aead_encrypt(codeKey, { dek: dek.toString('hex') }, `${handle}/code`);

  // Verify new code can decrypt
  const clientSeed = await deriveSeed(normalizeCode(newCode), handle, randomSalt);
  const clientCodeKey = hkdf(clientSeed, 'swep/wrap');
  const decryptedObj = aead_decrypt(clientCodeKey, newWrapCode, `${handle}/code`);
  assert.strictEqual(decryptedObj.dek, dek.toString('hex'));
});

test('vault: isGistTarget identifies gist IDs and prefixes', async () => {
  const { isGistTarget } = await import('../src/vault.js');
  assert.strictEqual(isGistTarget('gist:aa5a315d61ae9438b18d'), true);
  assert.strictEqual(isGistTarget('aa5a315d61ae9438b18d'), true);
  assert.strictEqual(isGistTarget('d41d8cd98f00b204e9800998ecf8427e'), true);
  assert.strictEqual(isGistTarget('swep-vault'), false);
  assert.strictEqual(isGistTarget('swep-vault-2'), false);
  assert.strictEqual(isGistTarget(''), false);
  assert.strictEqual(isGistTarget(null), false);
});

test('vault: code rotation invalidates previous login code permanently', async () => {
  const cryptoModule = await import('crypto');
  const handle = 'rotationuser';
  const dek = generateDEK();

  // First session: Code 0
  const code0 = generateCode(10);
  const salt0 = cryptoModule.default.randomBytes(16);
  const seed0 = await deriveSeed(normalizeCode(code0), handle, salt0);
  const codeKey0 = hkdf(seed0, 'swep/wrap');
  let currentWrapCode = aead_encrypt(codeKey0, { dek: dek.toString('hex') }, `${handle}/code`);

  // Verify Code 0 can decrypt
  const clientSeed0 = await deriveSeed(normalizeCode(code0), handle, salt0);
  const clientKey0 = hkdf(clientSeed0, 'swep/wrap');
  const obj0 = aead_decrypt(clientKey0, currentWrapCode, `${handle}/code`);
  assert.strictEqual(obj0.dek, dek.toString('hex'));

  // End of session: ROTATE to Code 1
  const code1 = generateCode(10);
  const salt1 = cryptoModule.default.randomBytes(16);
  const seed1 = await deriveSeed(normalizeCode(code1), handle, salt1);
  const codeKey1 = hkdf(seed1, 'swep/wrap');
  currentWrapCode = aead_encrypt(codeKey1, { dek: dek.toString('hex') }, `${handle}/code`);

  // Code 1 successfully decrypts
  const clientSeed1 = await deriveSeed(normalizeCode(code1), handle, salt1);
  const clientKey1 = hkdf(clientSeed1, 'swep/wrap');
  const obj1 = aead_decrypt(clientKey1, currentWrapCode, `${handle}/code`);
  assert.strictEqual(obj1.dek, dek.toString('hex'));

  // Attempting to decrypt rotated vault with OLD Code 0 MUST FAIL
  assert.throws(() => {
    aead_decrypt(clientKey0, currentWrapCode, `${handle}/code`);
  });
});


