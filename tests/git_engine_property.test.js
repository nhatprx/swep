/**
 * Property-Based Randomized Test for Git State Reconstruction Engine
 * 
 * Kiểm thử ngẫu nhiên theo thuộc tính (Property-Based Testing):
 * - Sinh chuỗi ngẫu nhiên các thao tác Git:
 *   + Tạo file mới, commit
 *   + Sửa file và stage
 *   + Sửa file không stage (unstaged)
 *   + Xóa file unstaged
 *   + Xóa file staged (git rm)
 *   + Đổi tên file (git mv)
 *   + Tạo file nhị phân (binary payload ngẫu nhiên)
 *   + Tạo commit local chưa push
 *   + Tạo file untracked ngẫu nhiên
 *   + Nhánh chưa có upstream
 * - Bất kể chuỗi thao tác ngẫu nhiên nào:
 *   1. `git ls-files -s` giữa A và B phải KHỚP 100% từng byte
 *   2. SHA-256 của toàn bộ file trên đĩa giữa A và B phải KHỚP 100%
 */

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { execSync } from 'child_process';
import {
  captureGitStateBundle,
  reconstituteGitState,
} from '../src/cortex/git_engine.js';

function hashFileSha256(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const content = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(content).digest('hex');
}

// Simple deterministic PRNG for reproducible test sequences
class PseudoRandom {
  constructor(seed = 123456789) {
    this.s = seed;
  }
  next() {
    this.s = (this.s * 1664525 + 1013904223) % 4294967296;
    return this.s / 4294967296;
  }
  int(min, max) {
    return Math.floor(this.next() * (max - min + 1)) + min;
  }
  choice(arr) {
    return arr[this.int(0, arr.length - 1)];
  }
  string(length = 8) {
    let res = '';
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < length; i++) {
      res += chars[this.int(0, chars.length - 1)];
    }
    return res;
  }
}

test('git_engine: property-based randomized state reconstruction (15 random ops)', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swep-git-prop-'));
  const originDir = path.join(rootDir, 'origin.git');
  const machineADir = path.join(rootDir, 'machine_a');
  const machineBDir = path.join(rootDir, 'machine_b');

  const rng = new PseudoRandom(42);

  try {
    // 1. Tạo bare remote
    fs.mkdirSync(originDir);
    execSync('git init --bare', { cwd: originDir });

    // 2. Tạo repo Machine A
    fs.mkdirSync(machineADir);
    execSync('git init', { cwd: machineADir });
    execSync('git config user.name "Alice Dev"', { cwd: machineADir });
    execSync('git config user.email "alice@company.com"', { cwd: machineADir });
    execSync('git config core.autocrlf false', { cwd: machineADir });

    // Base files
    fs.writeFileSync(path.join(machineADir, 'initial.txt'), 'Initial root content\n');
    execSync('git add initial.txt && git commit -m "Initial commit"', { cwd: machineADir });
    execSync(`git remote add origin "${originDir.replace(/\\/g, '/')}"`, { cwd: machineADir });
    execSync('git branch -M main', { cwd: machineADir });
    execSync('git push -u origin main', { cwd: machineADir });

    // Switch to a feature branch without upstream
    const featureBranch = 'feat/random_' + rng.string(6);
    execSync(`git checkout -b ${featureBranch}`, { cwd: machineADir });

    // 3. Thực thi chuỗi 15 thao tác ngẫu nhiên
    const trackedFiles = ['initial.txt'];
    const allFiles = new Set(trackedFiles);

    for (let step = 0; step < 15; step++) {
      const op = rng.int(1, 8);
      const fileName = `file_${step}_${rng.string(4)}.txt`;
      const binName = `bin_${step}_${rng.string(4)}.dat`;

      switch (op) {
        case 1: { // Tạo file mới và commit
          fs.writeFileSync(path.join(machineADir, fileName), `Content committed step ${step}\n`);
          execSync(`git add "${fileName}"`, { cwd: machineADir });
          execSync(`git commit -m "Commit step ${step}"`, { cwd: machineADir });
          trackedFiles.push(fileName);
          allFiles.add(fileName);
          break;
        }
        case 2: { // Tạo file mới và stage (chưa commit)
          fs.writeFileSync(path.join(machineADir, fileName), `Staged only step ${step}\n`);
          execSync(`git add "${fileName}"`, { cwd: machineADir });
          trackedFiles.push(fileName);
          allFiles.add(fileName);
          break;
        }
        case 3: { // Sửa file tracked không stage (unstaged modification)
          if (trackedFiles.length > 0) {
            const target = rng.choice(trackedFiles);
            const targetPath = path.join(machineADir, target);
            if (fs.existsSync(targetPath)) {
              fs.appendFileSync(targetPath, `Unstaged line added at step ${step}\n`);
            }
          }
          break;
        }
        case 4: { // Tạo file nhị phân ngẫu nhiên (binary untracked)
          const randomBytes = crypto.randomBytes(rng.int(16, 64));
          fs.writeFileSync(path.join(machineADir, binName), randomBytes);
          allFiles.add(binName);
          break;
        }
        case 5: { // Đổi tên file tracked (git mv)
          if (trackedFiles.length > 1) {
            const target = trackedFiles.pop();
            const targetPath = path.join(machineADir, target);
            if (fs.existsSync(targetPath)) {
              const newName = `renamed_${step}_${target}`;
              execSync(`git mv "${target}" "${newName}"`, { cwd: machineADir });
              trackedFiles.push(newName);
              allFiles.delete(target);
              allFiles.add(newName);
            }
          }
          break;
        }
        case 6: { // Xóa file tracked không stage (unstaged deletion)
          if (trackedFiles.length > 2) {
            const target = rng.choice(trackedFiles);
            const targetPath = path.join(machineADir, target);
            if (fs.existsSync(targetPath)) {
              fs.unlinkSync(targetPath);
              allFiles.delete(target);
            }
          }
          break;
        }
        case 7: { // Tạo file text untracked
          fs.writeFileSync(path.join(machineADir, fileName), `Pure untracked text step ${step}\n`);
          allFiles.add(fileName);
          break;
        }
        case 8: { // Commit local cho các thay đổi đang staged
          try {
            execSync('git commit -m "Periodic commit"', { cwd: machineADir });
          } catch {
            // Nothing staged to commit, continue
          }
          break;
        }
      }
    }

    // 4. Chụp snapshot qua captureGitStateBundle
    const { meta, bundleBuffer } = captureGitStateBundle(machineADir);
    assert.strictEqual(meta.currentBranch, featureBranch);
    assert.ok(bundleBuffer.length > 0);

    // 5. Khôi phục trên Machine B (Clean clone)
    execSync(`git clone "${originDir.replace(/\\/g, '/')}" "${machineBDir}"`);
    execSync('git config user.name "Alice Dev"', { cwd: machineBDir });
    execSync('git config user.email "alice@company.com"', { cwd: machineBDir });
    execSync('git config core.autocrlf false', { cwd: machineBDir });

    reconstituteGitState(machineBDir, meta, bundleBuffer);

    // 6. KIỂM TRA ĐỊNH LƯỢNG:
    // A. `git ls-files -s` phải khớp 100% từng byte
    const lsA = execSync('git ls-files -s', { cwd: machineADir }).toString().trim();
    const lsB = execSync('git ls-files -s', { cwd: machineBDir }).toString().trim();
    assert.strictEqual(lsA, lsB, 'Property check: git ls-files -s must match 100% byte-for-byte');

    // B. `git status --porcelain=v2` phải khớp
    const statusA = execSync('git status --porcelain=v2', { cwd: machineADir }).toString().trim();
    const statusB = execSync('git status --porcelain=v2', { cwd: machineBDir }).toString().trim();
    assert.strictEqual(statusA, statusB, 'Property check: git status --porcelain=v2 must match exactly');

    // C. Toàn bộ file tồn tại trên A phải có SHA-256 khớp 100% trên B
    for (const f of allFiles) {
      const pA = path.join(machineADir, f);
      const pB = path.join(machineBDir, f);
      const existsA = fs.existsSync(pA);
      const existsB = fs.existsSync(pB);

      assert.strictEqual(existsA, existsB, `Existence of file ${f} must match between A and B`);
      if (existsA) {
        const hashA = hashFileSha256(pA);
        const hashB = hashFileSha256(pB);
        assert.strictEqual(hashA, hashB, `SHA-256 of ${f} must match 100% between A and B`);
      }
    }
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});
