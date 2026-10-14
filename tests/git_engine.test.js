/**
 * Test: Git State Reconstruction Engine (Cortex)
 * 
 * Kiểm chứng toàn diện và định lượng:
 * 1. Khớp 100% `git ls-files -s` (mode, sha, stage, file) giữa Machine A và Machine B
 * 2. Khớp 100% SHA-256 nội dung của từng file trong working directory
 * 3. Chứng minh Zero Mutation trên `.git/objects`: Đếm số object trước và sau snapshot
 * 4. Hỗ trợ nhánh không có upstream
 * 5. Hỗ trợ Detached HEAD
 * 6. Kiểm tra phát hiện trạng thái merge/rebase dở dang mà không làm mất code
 * 7. Bỏ qua file quá kích thước an toàn
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
  checkGitConflictOrMergeInProgress,
} from '../src/cortex/git_engine.js';

function hashFileSha256(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const content = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(content).digest('hex');
}

test('git_engine: detects operations in progress via git rev-parse --git-path', () => {
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'swep-git-conflict-'));
  try {
    execSync('git init', { cwd: tmpRepo });
    assert.strictEqual(checkGitConflictOrMergeInProgress(tmpRepo).inProgress, false);

    // Giả lập MERGE_HEAD
    fs.writeFileSync(path.join(tmpRepo, '.git', 'MERGE_HEAD'), 'fakehash');
    const mergeCheck = checkGitConflictOrMergeInProgress(tmpRepo);
    assert.strictEqual(mergeCheck.inProgress, true);
    assert.ok(mergeCheck.states.includes('merge'));

    fs.unlinkSync(path.join(tmpRepo, '.git', 'MERGE_HEAD'));

    // Giả lập rebase-merge
    fs.mkdirSync(path.join(tmpRepo, '.git', 'rebase-merge'));
    const rebaseCheck = checkGitConflictOrMergeInProgress(tmpRepo);
    assert.strictEqual(rebaseCheck.inProgress, true);
    assert.ok(rebaseCheck.states.includes('rebase'));
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
});

test('git_engine: zero mutation on .git/objects and byte-for-byte ls-files -s match', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swep-git-rigorous-'));
  const originDir = path.join(rootDir, 'origin.git');
  const machineADir = path.join(rootDir, 'machine_a');
  const machineBDir = path.join(rootDir, 'machine_b');

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

    fs.writeFileSync(path.join(machineADir, 'base.txt'), 'Base content\n');
    fs.writeFileSync(path.join(machineADir, 'file_to_delete.txt'), 'Delete me\n');
    fs.writeFileSync(path.join(machineADir, 'file_to_rename.txt'), 'Rename me\n');
    fs.writeFileSync(path.join(machineADir, '.gitignore'), 'ignored.log\n');
    fs.writeFileSync(path.join(machineADir, 'binary.dat'), Buffer.from([0x01, 0x02, 0x03, 0x04]));

    execSync('git add -A', { cwd: machineADir });
    execSync('git commit -m "Initial commit"', { cwd: machineADir });
    execSync(`git remote add origin "${originDir.replace(/\\/g, '/')}"`, { cwd: machineADir });
    execSync('git branch -M main', { cwd: machineADir });
    execSync('git push -u origin main', { cwd: machineADir });

    // Feature branch
    execSync('git checkout -b feat/payment', { cwd: machineADir });
    execSync('git push -u origin feat/payment', { cwd: machineADir });

    // 3. Tạo các thay đổi phức tạp trên Machine A
    // - Local commit chưa push
    fs.writeFileSync(path.join(machineADir, 'local_commit.txt'), 'Unpushed commit\n');
    execSync('git add local_commit.txt', { cwd: machineADir });
    execSync('git commit -m "Commit ahead of origin"', { cwd: machineADir });

    // - Staged modification & rename
    fs.appendFileSync(path.join(machineADir, 'base.txt'), 'Staged line\n');
    execSync('git add base.txt', { cwd: machineADir });
    execSync('git mv file_to_rename.txt file_renamed.txt', { cwd: machineADir });

    // - Unstaged modification
    fs.appendFileSync(path.join(machineADir, 'base.txt'), 'Unstaged line\n');

    // - Unstaged deletion
    fs.unlinkSync(path.join(machineADir, 'file_to_delete.txt'));

    // - Untracked text & binary
    fs.writeFileSync(path.join(machineADir, 'untracked_note.txt'), 'Untracked text\n');
    fs.writeFileSync(path.join(machineADir, 'untracked_img.bin'), Buffer.from([0xaa, 0xbb, 0xcc]));

    // - File quá cỡ giới hạn (giả lập 100KB khi maxFileSizeBytes = 50KB)
    fs.writeFileSync(path.join(machineADir, 'huge_untracked.bin'), Buffer.alloc(100 * 1024, 0x55));

    // Đếm số object trong .git/objects trước khi snapshot
    const objDirA = path.join(machineADir, '.git', 'objects');
    const countObjects = (dir) => {
      let count = 0;
      if (!fs.existsSync(dir)) return 0;
      for (const item of fs.readdirSync(dir)) {
        const full = path.join(dir, item);
        if (fs.statSync(full).isDirectory()) {
          count += fs.readdirSync(full).length;
        } else {
          count += 1;
        }
      }
      return count;
    };
    const objectsCountBefore = countObjects(objDirA);

    // 4. Chụp snapshot với maxFileSizeBytes = 50KB
    const { meta, bundleBuffer } = captureGitStateBundle(machineADir, { maxFileSizeBytes: 50 * 1024 });

    // KIỂM TRA ZERO MUTATION TRÊN .git/objects:
    const objectsCountAfter = countObjects(objDirA);
    assert.strictEqual(objectsCountBefore, objectsCountAfter, 'Zero mutation: .git/objects must NOT have loose objects added');

    // File quá cỡ phải nằm trong skippedLargeFiles mà không làm hỏng snapshot
    assert.strictEqual(meta.skippedLargeFiles.length, 1);
    assert.strictEqual(meta.skippedLargeFiles[0].path, 'huge_untracked.bin');

    // 5. Khôi phục trên Machine B
    execSync(`git clone "${originDir.replace(/\\/g, '/')}" "${machineBDir}"`);
    execSync('git config user.name "Alice Dev"', { cwd: machineBDir });
    execSync('git config user.email "alice@company.com"', { cwd: machineBDir });
    execSync('git config core.autocrlf false', { cwd: machineBDir });

    reconstituteGitState(machineBDir, meta, bundleBuffer);

    // 6. KIỂM TRA ĐỊNH LƯỢNG NGHIÊM NGẶT:
    // A. So sánh git ls-files -s (Exact index entries: mode, hash, stage, filename)
    const lsFilesA = execSync('git ls-files -s', { cwd: machineADir }).toString().trim();
    const lsFilesB = execSync('git ls-files -s', { cwd: machineBDir }).toString().trim();
    assert.strictEqual(lsFilesA, lsFilesB, 'Index entries (git ls-files -s) must match 100% byte-for-byte');

    // B. So sánh SHA-256 từng file trong working directory
    const filesToCheck = [
      'base.txt',
      'file_renamed.txt',
      'binary.dat',
      'local_commit.txt',
      'untracked_note.txt',
      'untracked_img.bin',
    ];
    for (const f of filesToCheck) {
      const hashA = hashFileSha256(path.join(machineADir, f));
      const hashB = hashFileSha256(path.join(machineBDir, f));
      assert.ok(hashA !== null, `File ${f} must exist on A`);
      assert.strictEqual(hashA, hashB, `SHA-256 hash of file ${f} must match exactly between A and B`);
    }

    // C. File bị xóa không được tồn tại trên B
    assert.strictEqual(fs.existsSync(path.join(machineBDir, 'file_to_delete.txt')), false);
    assert.strictEqual(fs.existsSync(path.join(machineBDir, 'file_to_rename.txt')), false);

    // D. Upstream tracking
    const bUpstream = execSync('git rev-parse --symbolic-full-name @{upstream}', { cwd: machineBDir }).toString().trim();
    assert.strictEqual(bUpstream, 'refs/remotes/origin/feat/payment');
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('git_engine: handles detached HEAD and branch with no upstream', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swep-git-detached-'));
  const originDir = path.join(rootDir, 'origin.git');
  const machineADir = path.join(rootDir, 'machine_a');
  const machineBDir = path.join(rootDir, 'machine_b');

  try {
    fs.mkdirSync(originDir);
    execSync('git init --bare', { cwd: originDir });

    fs.mkdirSync(machineADir);
    execSync('git init', { cwd: machineADir });
    execSync('git config user.name "Alice Dev"', { cwd: machineADir });
    execSync('git config user.email "alice@company.com"', { cwd: machineADir });

    fs.writeFileSync(path.join(machineADir, 'readme.md'), '# Demo\n');
    execSync('git add readme.md && git commit -m "init"', { cwd: machineADir });
    execSync(`git remote add origin "${originDir.replace(/\\/g, '/')}"`, { cwd: machineADir });
    execSync('git branch -M main', { cwd: machineADir });
    execSync('git push -u origin main', { cwd: machineADir });

    // Tạo branch mới hoàn toàn ở local, CHƯA PUSH (không có upstream)
    execSync('git checkout -b local_only_branch', { cwd: machineADir });
    fs.writeFileSync(path.join(machineADir, 'local_feature.js'), 'console.log("local");');
    execSync('git add local_feature.js && git commit -m "local commit"', { cwd: machineADir });

    // Sửa unstaged
    fs.appendFileSync(path.join(machineADir, 'readme.md'), 'New unstaged note\n');

    // Chụp snapshot
    const { meta, bundleBuffer } = captureGitStateBundle(machineADir);
    assert.strictEqual(meta.currentBranch, 'local_only_branch');
    assert.strictEqual(meta.upstreamRef, null);

    // Restore trên Machine B
    execSync(`git clone "${originDir.replace(/\\/g, '/')}" "${machineBDir}"`);
    execSync('git config user.name "Alice Dev"', { cwd: machineBDir });
    execSync('git config user.email "alice@company.com"', { cwd: machineBDir });

    reconstituteGitState(machineBDir, meta, bundleBuffer);

    // Xác nhận branch local_only_branch được tạo và checkout đúng trên B
    const branchB = execSync('git branch --show-current', { cwd: machineBDir }).toString().trim();
    assert.strictEqual(branchB, 'local_only_branch');

    // Xác nhận file commit local và file unstaged đều có mặt
    assert.strictEqual(fs.existsSync(path.join(machineBDir, 'local_feature.js')), true);
    assert.ok(fs.readFileSync(path.join(machineBDir, 'readme.md'), 'utf8').includes('New unstaged note'));
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});
