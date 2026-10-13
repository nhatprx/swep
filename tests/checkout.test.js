import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { maskKey, saveActiveSession, readActiveSession, removeActiveSession, getActiveKey } from '../src/bridge.js';
import { performCleanup } from '../src/cleanup.js';
import { checkoutCommand } from '../src/commands/checkout.js';

test('maskKey: formats keys into handle-ABxx-xxxC masking pattern', () => {
  assert.strictEqual(maskKey('nhatprx-AB1234567C'), 'nhatprx-ABxx-xxxC');
  assert.strictEqual(maskKey('nhatprx-03FA93510B'), 'nhatprx-03xx-xxxB');
  assert.strictEqual(maskKey('user-XYZ123456W'), 'user-XYxx-xxxW');
  assert.strictEqual(maskKey('test-1234'), 'test-****');
  assert.strictEqual(maskKey(''), '');
});

test('session: save, getActiveKey with maskedKey, and remove', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swep-test-session-'));
  try {
    saveActiveSession(tmpDir, {
      handle: 'nhatprx',
      loginCode: 'nhatprx-AB1234567C',
    });

    // Without chrome-profile, should return null (no ghost session)
    assert.strictEqual(getActiveKey(tmpDir), null);

    // With chrome-profile, should return active key
    fs.mkdirSync(path.join(tmpDir, 'chrome-profile'), { recursive: true });
    saveActiveSession(tmpDir, {
      handle: 'nhatprx',
      loginCode: 'nhatprx-AB1234567C',
    });

    const active = getActiveKey(tmpDir);
    assert.ok(active);
    assert.strictEqual(active.rawKey, 'nhatprx-AB1234567C');
    assert.strictEqual(active.maskedKey, 'nhatprx-ABxx-xxxC');

    removeActiveSession(tmpDir);
    assert.strictEqual(readActiveSession(tmpDir), null);
    assert.strictEqual(getActiveKey(tmpDir), null);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('cleanup: selfDestruct: false clears profile and session without self-destructing swep', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swep-test-cleanup-'));
  try {
    const profileDir = path.join(tmpDir, 'chrome-profile');
    const stateDir = path.join(tmpDir, 'state');
    fs.mkdirSync(profileDir, { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(profileDir, 'Cookies'), 'dummy');
    fs.writeFileSync(path.join(tmpDir, 'active-session.json'), JSON.stringify({ handle: 'test' }));

    const report = await performCleanup(tmpDir, { selfDestruct: false });

    assert.strictEqual(fs.existsSync(profileDir), false);
    assert.strictEqual(fs.existsSync(stateDir), false);
    assert.strictEqual(fs.existsSync(path.join(tmpDir, 'active-session.json')), false);
    assert.strictEqual(report.uninstalledSwep, false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('checkoutCommand: runs dryRun cleanly', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swep-test-checkout-'));
  try {
    saveActiveSession(tmpDir, {
      handle: 'nhatprx',
      loginCode: 'nhatprx-AB1234567C',
    });
    // Should run dryRun without throwing
    await checkoutCommand({ root: tmpDir, dryRun: true });
    // In dryRun, session should still exist
    assert.ok(readActiveSession(tmpDir));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
