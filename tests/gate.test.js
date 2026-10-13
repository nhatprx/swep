/**
 * Integration Test: End-to-end Gate & Client Crypto flow
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert';
import { createGateServer } from '../gate/server.js';
import { GateClient } from '../src/gate.js';
import {
  generateDEK,
  deriveSeed,
  hkdf,
  aead_encrypt,
  aead_decrypt,
  generateRecoveryKey,
  deriveRecoveryKeyBuffer,
  deriveRecoveryAuth,
} from '../src/crypto.js';

let server;
let client;
const TEST_PORT = 3199;

before(async () => {
  server = createGateServer();
  await new Promise((resolve) => server.listen(TEST_PORT, resolve));
  client = new GateClient(`http://localhost:${TEST_PORT}`);
});

after(async () => {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('e2e: health check', async () => {
  const ok = await client.healthCheck();
  assert.strictEqual(ok, true);
});

test('e2e: register, login, rotate, and revoke flow', async () => {
  const handle = 'testuser';
  const dek = generateDEK();

  // 1. Register
  const rawPayload = {
    google_email: 'user@gmail.com',
    google_password: 'secretPassword123',
    totp_secret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
    version: 1,
  };
  const encPayload = aead_encrypt(dek, rawPayload, `${handle}/1`);

  const code1 = 'ABC123';
  const seed1 = await deriveSeed(code1, handle);
  const authKey1 = hkdf(seed1, 'swep/auth');
  const codeKey1 = hkdf(seed1, 'swep/wrap');
  const wrapCode1 = aead_encrypt(codeKey1, { dek: dek.toString('hex') }, `${handle}/code`);

  const recoveryKey = generateRecoveryKey();
  const recoveryKeyBuf = deriveRecoveryKeyBuffer(recoveryKey);
  const wrapRecovery = aead_encrypt(recoveryKeyBuf, { dek: dek.toString('hex') }, `${handle}/recovery`);
  const recoveryAuth = deriveRecoveryAuth(recoveryKey);

  const regRes = await client.register({
    github_token: 'dummy',
    handle,
    google_email: rawPayload.google_email,
    auth_hash: authKey1.toString('hex'),
    wrap_code: wrapCode1,
    wrap_recovery: wrapRecovery,
    recovery_auth: recoveryAuth,
    payload: encPayload,
  });
  assert.strictEqual(regRes.status, 'ok');

  // 2. Login with code1
  const loginRes = await client.login(handle, authKey1.toString('hex'));
  assert.strictEqual(loginRes.status, 'ok');
  assert.ok(loginRes.session);

  // Decrypt DEK and payload
  const decDekObj = aead_decrypt(codeKey1, loginRes.wrap_code, `${handle}/code`);
  const decDek = Buffer.from(decDekObj.dek, 'hex');
  const decPayload = aead_decrypt(decDek, loginRes.payload, `${handle}/1`);
  assert.strictEqual(decPayload.google_email, 'user@gmail.com');
  assert.strictEqual(decPayload.google_password, 'secretPassword123');

  // 3. Stage new code: code2
  const code2 = 'XYZ789';
  const seed2 = await deriveSeed(code2, handle);
  const authKey2 = hkdf(seed2, 'swep/auth');
  const codeKey2 = hkdf(seed2, 'swep/wrap');
  const wrapCode2 = aead_encrypt(codeKey2, { dek: dek.toString('hex') }, `${handle}/code`);

  const stageRes = await client.rotateStage(loginRes.session, authKey2.toString('hex'), wrapCode2);
  assert.strictEqual(stageRes.status, 'ok');

  // 4. Confirm rotation
  const confirmRes = await client.rotateConfirm(loginRes.session);
  assert.strictEqual(confirmRes.status, 'ok');

  // 5. Old code1 should now fail
  await assert.rejects(
    async () => {
      await client.login(handle, authKey1.toString('hex'));
    },
    { status: 401 }
  );

  // 6. New code2 should succeed!
  const loginRes2 = await client.login(handle, authKey2.toString('hex'));
  assert.strictEqual(loginRes2.status, 'ok');

  // 7. Revoke account
  await client.revoke('dummy_token');

  // Now login with code2 must fail
  await assert.rejects(
    async () => {
      await client.login(handle, authKey2.toString('hex'));
    },
    { status: 410 }
  );

  // 8. Recover account
  const recoverRes = await client.recover('dummy_token', handle, recoveryAuth);
  assert.strictEqual(recoverRes.status, 'ok');

  // Restore DEK from recovery
  const recoveredDekObj = aead_decrypt(recoveryKeyBuf, recoverRes.wrap_recovery, `${handle}/recovery`);
  assert.strictEqual(recoveredDekObj.dek, dek.toString('hex'));
});
