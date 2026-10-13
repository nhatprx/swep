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
      await execAsync(`cmd /c "rd /s /q \\"${dirPath}\\""`, { windowsHide: true });
      if (!fs.existsSync(dirPath)) return;
    } catch {
      // ignore
    }

    // 3. Thử với PowerShell Remove-Item
    try {
      const psScript = `Remove-Item -LiteralPath "${dirPath}" -Recurse -Force -ErrorAction SilentlyContinue`;
      const b64 = Buffer.from(psScript, 'utf16le').toString('base64');
      await execAsync(`powershell -NoProfile -WindowStyle Hidden -NonInteractive -EncodedCommand ${b64}`, { windowsHide: true });
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
  const { dryRun = false, selfDestruct = true } = options;
  const ledger = readLedger(rootDir);

  const report = {
    killedProcesses: 0,
    removedFiles: [],
    uninstalledChrome: false,
    uninstalledSwep: false,
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
      await execAsync('powershell -NoProfile -WindowStyle Hidden -NonInteractive -Command "Set-Clipboard -Value \\"\\""', { windowsHide: true });
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
        await execAsync('winget uninstall Google.Chrome --silent', { timeout: 60000, windowsHide: true });
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

    // Xóa các file session và extension tạm thời
    for (const f of ['latest-cookies.json', 'active-session.json', 'watchdog.pid']) {
      const fp = path.join(rootDir, f);
      if (fs.existsSync(fp)) {
        try {
          fs.unlinkSync(fp);
          report.removedFiles.push(fp);
        } catch {}
      }
    }
    const extDir = path.join(rootDir, 'extension');
    if (fs.existsSync(extDir)) {
      await removeDirectoryRecursive(extDir);
      report.removedFiles.push(extDir);
    }

    // 6. Tự hủy toàn bộ Swep trên hệ thống (Self-Destruction) chỉ khi selfDestruct = true
    if (selfDestruct) {
      const localAppData = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || 'C:\\', 'AppData', 'Local');
      const defaultSwepDir = path.join(localAppData, 'Swep').toLowerCase();
      const isInstalledSwep =
        (path.resolve(rootDir).toLowerCase() === defaultSwepDir) ||
        fs.existsSync(path.join(rootDir, 'bin', 'swep.cmd')) ||
        fs.existsSync(path.join(rootDir, 'app'));

    if (isInstalledSwep) {
      const binDir = path.join(rootDir, 'bin');
      const swepCmd = path.join(binDir, 'swep.cmd');

      // 6.1 Gỡ sạch Swep khỏi Registry User PATH đồng bộ (synchronous) ngay lập tức
      try {
        const psRemovePath = `
$regPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($regPath) {
  $items = ($regPath -split ';') | Where-Object { $_ -and $_ -notlike '*\\Swep*' }
  [Environment]::SetEnvironmentVariable('Path', ($items -join ';'), 'User')
}
`;
        const b64 = Buffer.from(psRemovePath, 'utf16le').toString('base64');
        await execAsync(`powershell -NoProfile -WindowStyle Hidden -NonInteractive -EncodedCommand ${b64}`, { windowsHide: true });
      } catch {
        // ignore
      }

      // 6.2 Xóa ngay file lệnh swep.cmd đồng bộ nếu có trong local root
      try {
        if (fs.existsSync(swepCmd)) {
          fs.unlinkSync(swepCmd);
        }
      } catch {
        // ignore
      }
    }

    // 6.2b Xóa ngay lập tức các file shim npm global (swep, swep.cmd, swep.ps1) để lệnh biến mất tức thì
    const npmGlobalDir = path.join(process.env.APPDATA || '', 'npm');
    if (fs.existsSync(npmGlobalDir)) {
      for (const shim of ['swep', 'swep.cmd', 'swep.ps1']) {
        const shimPath = path.join(npmGlobalDir, shim);
        try {
          if (fs.existsSync(shimPath)) {
            fs.unlinkSync(shimPath);
            report.removedFiles.push(shimPath);
          }
        } catch {
          // ignore
        }
      }
    }

    // 6.3 Tắt các tiến trình node chạy ngầm của Swep (nếu có, trừ chính process hiện tại)
    try {
      const killLingering = `
Get-CimInstance Win32_Process | Where-Object { ($_.CommandLine -like '*\\Swep\\*' -or $_.CommandLine -like '*swep.js*') -and $_.ProcessId -ne ${process.pid} } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
`;
      const b64Kill = Buffer.from(killLingering, 'utf16le').toString('base64');
      await execAsync(`powershell -NoProfile -WindowStyle Hidden -NonInteractive -EncodedCommand ${b64Kill}`, { windowsHide: true });
    } catch {
      // ignore
    }

    // 6.4 Kích hoạt tiến trình PowerShell ngầm độc lập để:
    // - Dọn sạch 100% thư mục %LOCALAPPDATA%\\Swep sau khi process.exit()
    // - Dọn sạch thư mục node_modules\\@nhatprx\\swep trong npm global
    try {
      const psDestructScript = `
Start-Sleep -Seconds 1
# 1. Dọn sạch thư mục %LOCALAPPDATA%\\Swep nếu có
for ($i = 0; $i -lt 10; $i++) {
  if (Test-Path -LiteralPath '${defaultSwepDir.replace(/'/g, "''")}') {
    Remove-Item -LiteralPath '${defaultSwepDir.replace(/'/g, "''")}' -Recurse -Force -ErrorAction SilentlyContinue
  } else {
    break
  }
  Start-Sleep -Milliseconds 500
}

# 2. Xóa sạch thư mục npm global package và file shim còn sót lại
$npmDir = "$env:APPDATA\\npm"
if (Test-Path $npmDir) {
  Remove-Item "$npmDir\\swep*" -Force -ErrorAction SilentlyContinue
  Remove-Item "$npmDir\\node_modules\\@nhatprx\\swep" -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item "$npmDir\\node_modules\\swep" -Recurse -Force -ErrorAction SilentlyContinue
}
`;
      const b64Destruct = Buffer.from(psDestructScript, 'utf16le').toString('base64');
      const cp = spawn('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-NonInteractive', '-EncodedCommand', b64Destruct], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      cp.unref();

      report.uninstalledSwep = true;
      report.removedFiles.push(defaultSwepDir);
    } catch {
      // ignore
    }
    }
  }

  return report;
}
