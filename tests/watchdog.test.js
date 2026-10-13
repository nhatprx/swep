import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { getInteractiveTerminalPid, silentCheckout } from '../src/watchdog.js';
import { saveActiveSession, readActiveSession } from '../src/bridge.js';

test('watchdog: getInteractiveTerminalPid returns valid number', async () => {
  const pid = await getInteractiveTerminalPid(process.ppid);
  assert.strictEqual(typeof pid, 'number');
  assert.ok(pid > 0);
});

test('watchdog: silentCheckout safely wipes profile without deleting swep binary or throwing', async () => {
  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swep-test-watchdog-'));
  const profileDir = path.join(testRoot, 'chrome-profile');
  fs.mkdirSync(profileDir, { recursive: true });
  fs.writeFileSync(path.join(profileDir, 'test-cookie.txt'), 'secret');

  saveActiveSession(testRoot, {
    handle: 'nhatprx',
    loginCode: 'nhatprx-ABCD-EFGH',
    dek: '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff',
  });

  assert.ok(readActiveSession(testRoot));
  assert.ok(fs.existsSync(profileDir));

  await silentCheckout(testRoot);

  assert.strictEqual(readActiveSession(testRoot), null);
  assert.strictEqual(fs.existsSync(profileDir), false);

  fs.rmSync(testRoot, { recursive: true, force: true });
});
