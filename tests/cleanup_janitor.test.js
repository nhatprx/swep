/**
 * Test: Safe Deletion Verification, Crash Janitor Quarantine & Isolated Credentials
 */

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  recordUploadReceipt,
  verifyUploadReceipt,
  runSessionJanitor,
} from '../src/cleanup.js';
import { createIsolatedGitCredentials } from '../src/cortex/git_engine.js';

test('cleanup: upload receipt recording and verification', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swep-receipt-test-'));
  try {
    assert.strictEqual(verifyUploadReceipt(tmpDir).verified, false);

    recordUploadReceipt(tmpDir, {
      sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      remoteTarget: 'gist:abc12345',
    });

    const check = verifyUploadReceipt(tmpDir);
    assert.strictEqual(check.verified, true);
    assert.strictEqual(check.receipt.sha256, 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('janitor: cleans verified sessions but quarantines unverified sessions without deleting code', async () => {
  const swepRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swep-janitor-test-'));
  try {
    const sessionsDir = path.join(swepRoot, 'runtime', 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });

    // 1. Session 1: Đã chết và ĐÃ VERIFY upload -> Janitor phải xóa sạch an toàn
    const sessVerified = path.join(sessionsDir, 'sess_verified');
    fs.mkdirSync(sessVerified);
    fs.writeFileSync(path.join(sessVerified, 'session.lock'), JSON.stringify({ pid: 999999, creationTime: '1970-01-01' }));
    recordUploadReceipt(sessVerified, { sha256: 'deadbeef1234', remoteTarget: 'gist:123' });

    // 2. Session 2: Đã chết nhưng CHƯA VERIFY upload -> Janitor TUYỆT ĐỐI KHÔNG XÓA, phải chuyển vào quarantine!
    const sessUnverified = path.join(sessionsDir, 'sess_unverified');
    fs.mkdirSync(sessUnverified);
    fs.writeFileSync(path.join(sessUnverified, 'session.lock'), JSON.stringify({ pid: 999998, creationTime: '1970-01-01' }));
    fs.writeFileSync(path.join(sessUnverified, 'precious_code.js'), 'console.log("must not be lost!");');

    // Chạy Janitor
    const report = await runSessionJanitor(swepRoot);

    assert.ok(report.cleaned.includes('sess_verified'), 'Verified session must be cleaned');
    assert.ok(report.quarantined.includes('sess_unverified'), 'Unverified session must be quarantined, NEVER deleted');

    // Kiểm tra đĩa: sess_verified không còn
    assert.strictEqual(fs.existsSync(sessVerified), false);

    // Kiểm tra đĩa: sess_unverified nằm trong quarantine và code vẫn nguyên vẹn
    const quarantinedCode = path.join(swepRoot, 'quarantine', 'sess_unverified', 'precious_code.js');
    assert.strictEqual(fs.existsSync(quarantinedCode), true);
    assert.strictEqual(fs.readFileSync(quarantinedCode, 'utf8'), 'console.log("must not be lost!");');
  } finally {
    fs.rmSync(swepRoot, { recursive: true, force: true });
  }
});

test('git_engine: createIsolatedGitCredentials produces non-leaking askpass env', () => {
  const creds = createIsolatedGitCredentials('ghp_test_secret_token_123');
  try {
    assert.ok(creds.env.GIT_ASKPASS, 'GIT_ASKPASS must be set');
    assert.strictEqual(creds.env.SWEP_ASKPASS_TOKEN, 'ghp_test_secret_token_123');
    assert.deepStrictEqual(creds.gitArgs, ['-c', 'credential.helper=']);
  } finally {
    creds.cleanup();
  }
});
