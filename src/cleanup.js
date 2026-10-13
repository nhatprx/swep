/**
 * Cleanup & Ledger utilities
 * Quản lý snapshot, ledger và dọn sạch hệ thống khi swep down
 */

import fs from 'fs';
import path from 'path';
import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import chalk from 'chalk';
import { killSwepChromeProcesses } from './chrome.js';

const execAsync = promisify(exec);

/**
 * Đảm bảo các thư mục trạng thái tồn tại
 * @param {string} rootDir
 */
export function ensureStateDirs(rootDir) {
  const dirs = [
    rootDir,
    path.join(rootDir, 'state'),
    path.join(rootDir, 'logs'),
    path.join(rootDir, 'chrome-profile'),
  ];
  for (const d of dirs) {
    if (!fs.existsSync(d)) {
      fs.mkdirSync(d, { recursive: true });
    }
  }
}

/**
 * Chụp snapshot trạng thái hệ thống trước khi bắt đầu
 * @param {string} rootDir
 * @param {object} initialInfo
 */
export function takeBeforeSnapshot(rootDir, initialInfo = {}) {
  ensureStateDirs(rootDir);
  const snapshotPath = path.join(rootDir, 'state', 'snapshot.before.json');
  const data = {
    timestamp: new Date().toISOString(),
    ...initialInfo,
  };
  fs.writeFileSync(snapshotPath, JSON.stringify(data, null, 2), 'utf8');
  return data;
}

/**
 * Ghi một mục vào sổ theo dõi (ledger.json)
 * @param {string} rootDir
 * @param {object} entry
 */
export function recordLedger(rootDir, entry) {
  ensureStateDirs(rootDir);
  const ledgerPath = path.join(rootDir, 'state', 'ledger.json');
  let ledger = [];
  if (fs.existsSync(ledgerPath)) {
    try {
      ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
    } catch {
      ledger = [];
    }
  }

  ledger.push({
    timestamp: new Date().toISOString(),
    ...entry,
  });

  fs.writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2), 'utf8');
}

/**
 * Đọc toàn bộ sổ theo dõi
 * @param {string} rootDir
 * @returns {Array<object>}
 */
export function readLedger(rootDir) {
  const ledgerPath = path.join(rootDir, 'state', 'ledger.json');
  if (fs.existsSync(ledgerPath)) {
    try {
      return JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * Xóa một thư mục đệ quy với retry nếu file bị khóa
 * @param {string} dirPath
 * @param {number} [retries=3]
 */
export async function removeDirectoryRecursive(dirPath, retries = 5) {
  if (!fs.existsSync(dirPath)) return;

  for (let i = 0; i < retries; i++) {
    // 1. Thử với fs.rmSync
    try {
      fs.rmSync(dirPath, { recursive: true, force: true });
      if (!fs.existsSync(dirPath)) return;
    } catch {
      // ignore
    }

    // 2. Thử với cmd rd /s /q (bỏ qua file lock & attributes trên Windows)
    try {
      await execAsync(`cmd /c "rd /s /q \\"${dirPath}\\""`);
      if (!fs.existsSync(dirPath)) return;
    } catch {
      // ignore
    }

    // 3. Thử với PowerShell Remove-Item
    try {
      const psScript = `Remove-Item -LiteralPath "${dirPath}" -Recurse -Force -ErrorAction SilentlyContinue`;
      const b64 = Buffer.from(psScript, 'utf16le').toString('base64');
      await execAsync(`powershell -NoProfile -EncodedCommand ${b64}`);
      if (!fs.existsSync(dirPath)) return;
    } catch {
      // ignore
    }

    if (!fs.existsSync(dirPath)) return;
    await new Promise((r) => setTimeout(r, 600));
  }
}

/**
 * Thực hiện toàn bộ quy trình dọn dẹp theo thứ tự chuẩn
 * @param {string} rootDir
 * @param {object} [options]
 * @returns {Promise<{ killedProcesses: number, removedFiles: string[], uninstalledChrome: boolean }>}
 */
export async function performCleanup(rootDir, options = {}) {
  const { dryRun = false } = options;
  const ledger = readLedger(rootDir);

  const report = {
    killedProcesses: 0,
    removedFiles: [],
    uninstalledChrome: false,
  };

  // 1. Đóng Chrome chỉ của Swep
  if (dryRun) {
    console.log(chalk.yellow('[dry-run] Sẽ đóng các tiến trình Chrome chạy profile Swep'));
  } else {
    report.killedProcesses = await killSwepChromeProcesses(rootDir);
    // Chờ 1.5s để Windows giải phóng hoàn toàn file handles của Chrome
    await new Promise((r) => setTimeout(r, 1500));
  }

  // 2. Xóa clipboard nếu còn
  if (dryRun) {
    console.log(chalk.yellow('[dry-run] Sẽ xóa dữ liệu trên clipboard'));
  } else {
    try {
      await execAsync('powershell -NoProfile -Command "Set-Clipboard -Value \\"\\""');
    } catch {
      // ignore
    }
  }

  // 3. Xóa chrome-profile
  const profileDir = path.join(rootDir, 'chrome-profile');
  if (fs.existsSync(profileDir)) {
    if (dryRun) {
      console.log(chalk.yellow(`[dry-run] Sẽ xóa thư mục profile: ${profileDir}`));
    } else {
      await removeDirectoryRecursive(profileDir);
      report.removedFiles.push(profileDir);
    }
  }

  // 4. Gỡ Chrome nếu ledger ghi do Swep cài (preexisting: false)
  const chromeInstallEntry = ledger.find((e) => e.action === 'install_chrome' && e.preexisting === false);
  if (chromeInstallEntry) {
    if (dryRun) {
      console.log(chalk.yellow('[dry-run] Sẽ gỡ Chrome vì Swep là bên đã cài'));
    } else {
      try {
        await execAsync('winget uninstall Google.Chrome --silent', { timeout: 60000 });
        report.uninstalledChrome = true;
      } catch {
        // winget uninstall failure
      }
    }
  }

  // 5. Xóa state/, logs/ và dọn thư mục gốc
  const stateDir = path.join(rootDir, 'state');
  const logsDir = path.join(rootDir, 'logs');

  if (dryRun) {
    console.log(chalk.yellow(`[dry-run] Sẽ xóa state và logs: ${stateDir}, ${logsDir}`));
  } else {
    if (fs.existsSync(stateDir)) {
      await removeDirectoryRecursive(stateDir);
      report.removedFiles.push(stateDir);
    }
    if (fs.existsSync(logsDir)) {
      await removeDirectoryRecursive(logsDir);
      report.removedFiles.push(logsDir);
    }

    // 6. Tự hủy toàn bộ Swep nếu chạy từ thư mục cài đặt (%LOCALAPPDATA%\Swep)
    const isInstalledSwep = fs.existsSync(path.join(rootDir, 'app')) || fs.existsSync(path.join(rootDir, 'bin'));
    if (isInstalledSwep) {
      const psScript = `
Start-Sleep -Seconds 2

# Gỡ Swep\\bin khỏi Registry User PATH
try {
  $regPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if ($regPath) {
    $items = ($regPath -split ';') | Where-Object { $_ -and $_ -notlike '*\\Swep\\bin*' -and $_ -notlike '*\\Swep\\bin' }
    $newPath = $items -join ';'
    [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
  }
} catch {}

# Xóa triệt để toàn bộ thư mục Swep
$target = '${rootDir.replace(/'/g, "''")}'
for ($i = 0; $i -lt 5; $i++) {
  if (-not (Test-Path -LiteralPath $target)) { break }
  cmd.exe /c "rd /s /q \\"$target\\"" 2>$null
  Remove-Item -LiteralPath $target -Recurse -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 800
}
`;
      const b64 = Buffer.from(psScript, 'utf16le').toString('base64');
      spawn('powershell', ['-NoProfile', '-WindowStyle', 'Hidden', '-EncodedCommand', b64], {
        detached: true,
        stdio: 'ignore',
      }).unref();

      report.uninstalledSwep = true;
      report.removedFiles.push(rootDir);
    } else {
      // Xóa thư mục gốc nếu rỗng (chế độ development)
      try {
        if (fs.existsSync(rootDir) && fs.readdirSync(rootDir).length === 0) {
          fs.rmdirSync(rootDir);
          report.removedFiles.push(rootDir);
        }
      } catch {
        // ignore
      }
    }
  }

  return report;
}
