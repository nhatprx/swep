/**
 * SWEP Cortex - Git State Reconstruction Engine
 * 
 * Đóng gói và tái tạo chính xác trạng thái Git đang làm dở:
 * - Zero Mutation trên .git/objects: Sử dụng GIT_OBJECT_DIRECTORY tạm và GIT_ALTERNATE_OBJECT_DIRECTORIES
 * - Phân biệt rạch ròi Staged vs Unstaged qua hai tầng tree
 * - Giữ nguyên file untracked (text + binary)
 * - Giữ nguyên commit local chưa push, tên branch (kể cả branch chưa có upstream) và upstream tracking
 * - Hỗ trợ Detached HEAD
 * - Xử lý đúng file bị xóa, file bị đổi tên
 * - Kiểm tra an toàn Path Traversal trước khi xóa file
 * - Giải quyết Git worktree / submodule (.git là file) bằng git rev-parse --git-path
 * - KHÔNG chặn thô bạo khi rebase dở hoặc file lớn: Gắn cờ cảnh báo để không làm mất code
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { execSync } from 'child_process';

/**
 * Kiểm tra xem repo có đang trong trạng thái merge / rebase / cherry-pick / revert dở dang không
 * Sử dụng `git rev-parse --git-path` để tương thích cả git worktree và submodule (.git là file)
 * @param {string} repoDir
 * @returns {{ inProgress: boolean, reason: string|null, states: string[] }}
 */
export function checkGitConflictOrMergeInProgress(repoDir) {
  try {
    const checkPath = (relPath) => {
      try {
        const p = execSync(`git rev-parse --git-path ${relPath}`, { cwd: repoDir }).toString().trim();
        const full = path.isAbsolute(p) ? p : path.join(repoDir, p);
        return fs.existsSync(full);
      } catch {
        return false;
      }
    };

    const states = [];
    if (checkPath('MERGE_HEAD')) states.push('merge');
    if (checkPath('rebase-merge') || checkPath('rebase-apply')) states.push('rebase');
    if (checkPath('CHERRY_PICK_HEAD')) states.push('cherry-pick');
    if (checkPath('REVERT_HEAD')) states.push('revert');
    if (checkPath('BISECT_LOG')) states.push('bisect');

    if (states.length > 0) {
      return {
        inProgress: true,
        reason: `Git operation in progress: ${states.join(', ')}`,
        states,
      };
    }
    return { inProgress: false, reason: null, states: [] };
  } catch {
    return { inProgress: false, reason: null, states: [] };
  }
}

/**
 * Tìm commit nền gần nhất trên remote để làm gốc cho bundle khi branch chưa có upstream
 * @param {string} repoDir
 * @param {string} currentHead
 * @returns {string|null}
 */
export function findBestBaseCommit(repoDir, currentHead) {
  try {
    // 1. Thử tìm remotes hiện có
    const remoteRefs = execSync('git rev-parse --remotes', { cwd: repoDir })
      .toString()
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);

    if (remoteRefs.length > 0) {
      // Tìm merge-base gần nhất giữa HEAD và bất kỳ remote ref nào
      for (const r of remoteRefs) {
        try {
          const mb = execSync(`git merge-base ${currentHead} ${r}`, { cwd: repoDir }).toString().trim();
          if (mb) return mb;
        } catch {
          // ignore
        }
      }
    }
  } catch {
    // ignore
  }

  // 2. Nếu không có remote nào, lấy commit đầu tiên (root commit) của repo
  try {
    const rootCommit = execSync('git rev-list --max-parents=0 HEAD', { cwd: repoDir }).toString().trim();
    if (rootCommit) return rootCommit;
  } catch {
    // ignore
  }

  return null;
}

/**
 * Tạo snapshot hai tầng (Staged + Unstaged) và đóng gói thành Git Bundle
 * @param {string} repoDir
 * @param {object} [options={}]
 * @param {number} [options.maxFileSizeBytes=52428800] 50MB giới hạn file untracked
 * @returns {object} Metadata và bundle buffer
 */
export function captureGitStateBundle(repoDir, options = {}) {
  const maxSizeBytes = options.maxFileSizeBytes || 50 * 1024 * 1024;
  const inProgressCheck = checkGitConflictOrMergeInProgress(repoDir);

  // 1. Nhận diện branch hiện tại (hoặc detached HEAD) và upstream
  let currentBranch = '';
  let isDetached = false;
  try {
    currentBranch = execSync('git branch --show-current', { cwd: repoDir }).toString().trim();
    if (!currentBranch) {
      isDetached = true;
    }
  } catch {
    isDetached = true;
  }

  const currentHead = execSync('git rev-parse HEAD', { cwd: repoDir }).toString().trim();

  let upstreamRef = null;
  let upstreamCommit = null;
  if (currentBranch && !isDetached) {
    try {
      upstreamRef = execSync(`git rev-parse --symbolic-full-name ${currentBranch}@{upstream}`, { cwd: repoDir }).toString().trim();
      upstreamCommit = execSync(`git rev-parse ${upstreamRef}`, { cwd: repoDir }).toString().trim();
    } catch {
      upstreamRef = null;
      upstreamCommit = null;
    }
  }

  // Xác định baseCommit cho bundle
  const baseCommit = upstreamCommit || findBestBaseCommit(repoDir, currentHead);

  // 2. Thiết lập GIT_OBJECT_DIRECTORY cách ly:
  // Đảm bảo không ghi bất kỳ loose object nào vào .git/objects của repo user!
  const tempId = crypto.randomBytes(8).toString('hex');
  const tempObjDir = path.join(os.tmpdir(), `swep_obj_${tempId}`);
  fs.mkdirSync(tempObjDir, { recursive: true });

  let realObjDir = '';
  try {
    realObjDir = execSync('git rev-parse --git-path objects', { cwd: repoDir }).toString().trim();
    if (!path.isAbsolute(realObjDir)) {
      realObjDir = path.join(repoDir, realObjDir);
    }
  } catch {
    realObjDir = path.join(repoDir, '.git', 'objects');
  }

  const isolatedEnv = {
    ...process.env,
    GIT_OBJECT_DIRECTORY: tempObjDir,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: realObjDir,
  };

  // 3. Freeze Index nguyên tử trong 1 lần đọc:
  // Lấy đường dẫn index qua git rev-parse --git-path index (tương thích cả worktree và submodule)
  let realIndexPath = '';
  try {
    realIndexPath = execSync('git rev-parse --git-path index', { cwd: repoDir }).toString().trim();
    if (!path.isAbsolute(realIndexPath)) {
      realIndexPath = path.join(repoDir, realIndexPath);
    }
  } catch {
    realIndexPath = path.join(repoDir, '.git', 'index');
  }

  const tempIndexPath = path.join(os.tmpdir(), `swep_idx_${tempId}`);
  if (fs.existsSync(realIndexPath)) {
    fs.copyFileSync(realIndexPath, tempIndexPath);
  }

  const envFrozen = {
    ...isolatedEnv,
    GIT_INDEX_FILE: tempIndexPath,
  };

  // Chụp Staged Tree từ tempIndex đã freeze (nguyên tử)
  const stagedTree = execSync('git write-tree', { cwd: repoDir, env: envFrozen }).toString().trim();
  const stagedCommit = execSync(`git commit-tree ${stagedTree} -p ${currentHead} -m "SWEP_STAGED"`, { cwd: repoDir, env: isolatedEnv }).toString().trim();

  // 4. Quét danh sách file untracked, lọc bỏ các file vượt quá kích thước (ghi vào danh sách bỏ qua thay vì crash)
  const untrackedList = execSync('git ls-files --others --exclude-standard', { cwd: repoDir })
    .toString()
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);

  const includedUntracked = [];
  const skippedLargeFiles = [];
  for (const relPath of untrackedList) {
    const full = path.join(repoDir, relPath);
    if (fs.existsSync(full)) {
      try {
        const stat = fs.statSync(full);
        if (stat.size > maxSizeBytes) {
          skippedLargeFiles.push({ path: relPath, sizeBytes: stat.size });
        } else {
          includedUntracked.push(relPath);
        }
      } catch {
        // ignore
      }
    }
  }

  // 5. Chụp Working Tree từ chính tempIndex đã freeze (bằng git add -A)
  let worktreeTree = '';
  let worktreeCommit = '';
  try {
    execSync('git add -A', { cwd: repoDir, env: envFrozen });
    worktreeTree = execSync('git write-tree', { cwd: repoDir, env: envFrozen }).toString().trim();
    worktreeCommit = execSync(`git commit-tree ${worktreeTree} -p ${stagedCommit} -m "SWEP_WORKTREE"`, { cwd: repoDir, env: isolatedEnv }).toString().trim();
  } finally {
    if (fs.existsSync(tempIndexPath)) {
      try { fs.unlinkSync(tempIndexPath); } catch { /* ignore */ }
    }
  }

  // 6. Đóng gói Git bundle từ baseCommit đến worktreeCommit
  const tempBundleRef = `refs/swep/tmp_${tempId}`;
  const tempBundleFile = path.join(os.tmpdir(), `swep_bundle_${tempId}.bundle`);

  // Lưu ref tạm trong isolatedEnv
  execSync(`git update-ref ${tempBundleRef} ${worktreeCommit}`, { cwd: repoDir, env: isolatedEnv });

  let bundleBuffer = null;
  try {
    if (baseCommit && baseCommit !== worktreeCommit) {
      execSync(`git bundle create "${tempBundleFile}" ${tempBundleRef} ^${baseCommit}`, { cwd: repoDir, env: isolatedEnv });
    } else {
      execSync(`git bundle create "${tempBundleFile}" ${tempBundleRef}`, { cwd: repoDir, env: isolatedEnv });
    }
    bundleBuffer = fs.readFileSync(tempBundleFile);
  } finally {
    // Dọn ref tạm
    try { execSync(`git update-ref -d ${tempBundleRef}`, { cwd: repoDir, env: isolatedEnv }); } catch { /* ignore */ }
    // Xóa bundle tạm
    if (fs.existsSync(tempBundleFile)) {
      try { fs.unlinkSync(tempBundleFile); } catch { /* ignore */ }
    }
    // XÓA TOÀN BỘ tempObjDir - Không để lại bất kỳ object rác nào trên máy!
    if (fs.existsSync(tempObjDir)) {
      try { fs.rmSync(tempObjDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }

  return {
    meta: {
      version: 2,
      currentBranch,
      isDetached,
      upstreamRef,
      upstreamCommit,
      baseCommit,
      currentHead,
      stagedTree,
      stagedCommit,
      worktreeTree,
      worktreeCommit,
      untrackedCount: includedUntracked.length,
      skippedLargeFiles,
      inProgressState: inProgressCheck.inProgress ? inProgressCheck.states : null,
      timestamp: new Date().toISOString(),
    },
    bundleBuffer,
  };
}

/**
 * Tái tạo trạng thái Git lên một repo đã clone trên máy B
 * @param {string} targetRepoDir Thư mục repo trên máy B
 * @param {object} meta Metadata từ captureGitStateBundle
 * @param {Buffer} bundleBuffer
 */
export function reconstituteGitState(targetRepoDir, meta, bundleBuffer) {
  const tempId = crypto.randomBytes(8).toString('hex');
  const tempBundleFile = path.join(os.tmpdir(), `swep_import_${tempId}.bundle`);
  fs.writeFileSync(tempBundleFile, bundleBuffer);

  const importRef = `refs/swep/import_${tempId}`;

  try {
    // 1. Xác minh bundle
    execSync(`git bundle verify "${tempBundleFile}"`, { cwd: targetRepoDir });

    // 2. Fetch commit từ bundle vào ref tạm
    execSync(`git fetch "${tempBundleFile}" ${meta.worktreeCommit}:${importRef}`, { cwd: targetRepoDir });

    // 3. Đảm bảo đúng branch và upstream tracking (hoặc detached HEAD)
    if (meta.isDetached || !meta.currentBranch) {
      execSync(`git checkout --detach ${meta.currentHead}`, { cwd: targetRepoDir });
    } else {
      // Dùng checkout -B để tạo mới hoặc reset đè lên nhánh mặc định nếu đã tồn tại
      execSync(`git checkout -B ${meta.currentBranch} ${meta.currentHead}`, { cwd: targetRepoDir });

      // Khôi phục upstream tracking nếu có
      if (meta.upstreamRef) {
        try {
          execSync(`git branch --set-upstream-to=${meta.upstreamRef}`, { cwd: targetRepoDir });
        } catch {
          // ignore nếu remote tracking ref chưa fetch
        }
      }
    }

    // 4. Khôi phục Working Tree qua temp index và checkout-index
    const restoreIndex = path.join(os.tmpdir(), `swep_rest_${tempId}`);
    try {
      const envRest = { ...process.env, GIT_INDEX_FILE: restoreIndex };
      execSync(`git read-tree ${meta.worktreeTree}`, { cwd: targetRepoDir, env: envRest });
      execSync('git checkout-index -a -f', { cwd: targetRepoDir, env: envRest });
    } finally {
      if (fs.existsSync(restoreIndex)) {
        try { fs.unlinkSync(restoreIndex); } catch { /* ignore */ }
      }
    }

    // 5. Xử lý xóa an toàn các file đã bị xóa hoặc đổi tên khỏi currentHead
    const removedFiles = execSync(`git diff-tree -r --name-only --diff-filter=D ${meta.currentHead} ${meta.worktreeTree}`, { cwd: targetRepoDir })
      .toString()
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);

    const targetResolved = path.resolve(targetRepoDir);
    for (const relPath of removedFiles) {
      const fullPath = path.resolve(targetRepoDir, relPath);
      // Chống Path Traversal: Đường dẫn bắt buộc phải nằm bên trong targetRepoDir!
      if (!fullPath.startsWith(targetResolved + path.sep)) {
        continue;
      }
      if (fs.existsSync(fullPath)) {
        try {
          fs.unlinkSync(fullPath);
        } catch (err) {
          // Xử lý file bị editor khóa trên Windows (EPERM / EBUSY)
          if (err.code === 'EPERM' || err.code === 'EBUSY') {
            try {
              // Thử bỏ cờ read-only nếu có
              fs.chmodSync(fullPath, 0o666);
              fs.unlinkSync(fullPath);
            } catch {
              // Ghi nhận cảnh báo thay vì làm sập toàn bộ quá trình restore
            }
          }
        }
      }
    }

    // 6. Khôi phục Staged State vào .git/index thật
    execSync(`git read-tree ${meta.stagedTree}`, { cwd: targetRepoDir });
  } finally {
    // Dọn sạch ref tạm và bundle file tạm
    try { execSync(`git update-ref -d ${importRef}`, { cwd: targetRepoDir }); } catch { /* ignore */ }
    if (fs.existsSync(tempBundleFile)) {
      try { fs.unlinkSync(tempBundleFile); } catch { /* ignore */ }
    }
  }
}

/**
 * Tạo script GIT_ASKPASS tạm thời và cấu hình tham số Git an toàn
 * Chống rò rỉ token vào .git/config và vô hiệu hóa Git Credential Manager của host
 * @param {string} token
 * @returns {{ env: object, gitArgs: string[], cleanup: () => void }}
 */
export function createIsolatedGitCredentials(token) {
  const tempId = crypto.randomBytes(8).toString('hex');
  const askpassScript = path.join(os.tmpdir(), `swep_askpass_${tempId}.js`);

  // Tạo script node nhỏ chỉ in token từ biến môi trường
  const scriptContent = `#!/usr/bin/env node\nprocess.stdout.write(process.env.SWEP_ASKPASS_TOKEN || '');\n`;
  fs.writeFileSync(askpassScript, scriptContent, { mode: 0o700 });

  const env = {
    ...process.env,
    GIT_ASKPASS: 'node',
    SWEP_ASKPASS_TOKEN: token,
  };

  // Trên Windows, GIT_ASKPASS gọi executable; tạo script cmd bọc
  let wrapperCmd = null;
  if (process.platform === 'win32') {
    wrapperCmd = path.join(os.tmpdir(), `swep_askpass_${tempId}.cmd`);
    fs.writeFileSync(wrapperCmd, `@node "${askpassScript}" %*\n`);
    env.GIT_ASKPASS = wrapperCmd;
  } else {
    env.GIT_ASKPASS = askpassScript;
  }

  return {
    env,
    gitArgs: ['-c', 'credential.helper='],
    cleanup: () => {
      try { if (fs.existsSync(askpassScript)) fs.unlinkSync(askpassScript); } catch { /* ignore */ }
      try { if (wrapperCmd && fs.existsSync(wrapperCmd)) fs.unlinkSync(wrapperCmd); } catch { /* ignore */ }
    },
  };
}

