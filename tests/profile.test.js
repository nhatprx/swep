import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import {
  packProfileDirectory,
  unpackProfileDirectory,
  encryptCapsule,
  decryptCapsule,
  sanitizeProfileForCurrentMachine,
} from '../src/profile.js';

test('profile: pack and unpack directory preserving structure and metadata', () => {
  const tmpDir = path.join(os.tmpdir(), 'swep-profile-test-' + Date.now());
  const unpackDir = path.join(os.tmpdir(), 'swep-profile-unpack-' + Date.now());
  
  fs.mkdirSync(path.join(tmpDir, 'Default', 'Local Storage', 'leveldb'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'Default', 'Preferences'), JSON.stringify({ theme: 'dark' }), 'utf8');
  fs.writeFileSync(path.join(tmpDir, 'Default', 'Local Storage', 'leveldb', '000001.ldb'), 'fake-leveldb-data', 'utf8');

  // Should ignore Cache directory
  fs.mkdirSync(path.join(tmpDir, 'Default', 'Cache'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'Default', 'Cache', 'data_0'), 'cached-data', 'utf8');

  const meta = { google_email: 'test@gmail.com', test: 123 };
  const packedGz = packProfileDirectory(tmpDir, meta);
  assert.ok(packedGz.length > 0);

  const { manifest, extractedFiles } = unpackProfileDirectory(packedGz, unpackDir);
  assert.equal(manifest.google_email, 'test@gmail.com');
  assert.equal(extractedFiles, 2); // Preferences and 000001.ldb (Cache excluded)

  assert.ok(fs.existsSync(path.join(unpackDir, 'Default', 'Preferences')));
  assert.ok(fs.existsSync(path.join(unpackDir, 'Default', 'Local Storage', 'leveldb', '000001.ldb')));
  assert.ok(!fs.existsSync(path.join(unpackDir, 'Default', 'Cache', 'data_0')));

  // Cleanup
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.rmSync(unpackDir, { recursive: true, force: true });
});

test('profile: AEAD ChaCha20-Poly1305 encryption, decryption, and integrity verification', () => {
  const dek = crypto.randomBytes(32);
  const data = Buffer.from('hello profile capsule secret payload');
  const aad = 'nhatprx/capsule/v2';

  const encrypted = encryptCapsule(data, dek, aad);
  assert.equal(encrypted.length, data.length + 33); // 5B magic + 12B nonce + 16B tag + data

  const decrypted = decryptCapsule(encrypted, dek, aad);
  assert.equal(decrypted.toString('utf8'), data.toString('utf8'));

  // Test integrity check: Tampering with 1 byte in ciphertext
  const tampered = Buffer.from(encrypted);
  tampered[tampered.length - 1] ^= 0x01; // flip 1 bit
  assert.throws(() => {
    decryptCapsule(tampered, dek, aad);
  }, /Xác thực tính toàn vẹn capsule thất bại/);

  // Test wrong AAD
  assert.throws(() => {
    decryptCapsule(encrypted, dek, 'wrong-aad');
  }, /Xác thực tính toàn vẹn capsule thất bại/);
});

test('profile: sanitizeProfileForCurrentMachine removes DPAPI locked files', () => {
  const tmpDir = path.join(os.tmpdir(), 'swep-dpapi-test-' + Date.now());
  fs.mkdirSync(path.join(tmpDir, 'Default', 'Network'), { recursive: true });
  
  fs.writeFileSync(path.join(tmpDir, 'Local State'), 'dpapi-key', 'utf8');
  fs.writeFileSync(path.join(tmpDir, 'Default', 'Network', 'Cookies'), 'dpapi-cookies', 'utf8');
  fs.writeFileSync(path.join(tmpDir, 'Default', 'Preferences'), 'prefs', 'utf8');

  sanitizeProfileForCurrentMachine(tmpDir);

  assert.ok(!fs.existsSync(path.join(tmpDir, 'Local State')));
  assert.ok(!fs.existsSync(path.join(tmpDir, 'Default', 'Network', 'Cookies')));
  assert.ok(fs.existsSync(path.join(tmpDir, 'Default', 'Preferences')));

  fs.rmSync(tmpDir, { recursive: true, force: true });
});
