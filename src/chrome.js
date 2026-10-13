/**
 * Chrome management for Windows
 * Tìm, mở, quản lý profile riêng và dọn dẹp tiến trình Chrome của Swep
 */

import fs from 'fs';
import path from 'path';
import { exec, spawn } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

/**
 * Các đường dẫn Chrome mặc định trên Windows
 */
const CHROME_PATHS = [
  path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe'),
  path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google\\Chrome\\Application\\chrome.exe'),
  path.join(process.env.LOCALAPPDATA || 'C:\\Users\\Default\\AppData\\Local', 'Google\\Chrome\\Application\\chrome.exe'),
];

/**
 * Lấy thư mục gốc mặc định của Swep (%LOCALAPPDATA%\Swep)
 * @param {string} [customRoot]
 * @returns {string}
 */
export function getSwepRoot(customRoot) {
  if (customRoot) {
    return path.resolve(customRoot);
  }
  const localAppData = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || 'C:\\', 'AppData', 'Local');
  return path.join(localAppData, 'Swep');
}

/**
 * Tìm đường dẫn chrome.exe trên máy
 * @returns {Promise<string|null>}
 */
export async function findChromePath() {
  for (const p of CHROME_PATHS) {
    if (fs.existsSync(p)) {
      return p;
    }
  }

  // Thử tìm qua lệnh `where chrome`
  try {
    const { stdout } = await execAsync('where chrome');
    const firstLine = stdout.trim().split(/\r?\n/)[0];
    if (firstLine && fs.existsSync(firstLine)) {
      return firstLine;
    }
  } catch {
    // Không tìm thấy trong PATH
  }

  return null;
}

/**
 * Cài đặt Google Chrome qua winget
 * @returns {Promise<boolean>}
 */
export async function installChromeViaWinget() {
  try {
    await execAsync('winget install Google.Chrome --silent --accept-package-agreements --accept-source-agreements', {
      timeout: 180000,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Khởi chạy Chrome với profile riêng biệt
 * @param {string} chromeExe
 * @param {string} rootDir
 * @param {string} [targetUrl]
 * @returns {Promise<import('child_process').ChildProcess>}
 */
export async function launchIsolatedChrome(chromeExe, rootDir, targetUrl = 'https://accounts.google.com') {
  const profileDir = path.join(rootDir, 'chrome-profile');
  if (!fs.existsSync(profileDir)) {
    fs.mkdirSync(profileDir, { recursive: true });
  }

  const args = [
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    targetUrl,
  ];

  const child = spawn(chromeExe, args, {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  return child;
}

/**
 * Mở một cửa sổ Chromium hoàn toàn mới, độc lập không dính dữ liệu cũ
 * dùng riêng cho quy trình xác thực GitHub / setup
 * @param {string} targetUrl
 * @returns {Promise<import('child_process').ChildProcess>}
 */
export async function openCleanBrowserForGitHub(targetUrl = 'https://github.com/settings/tokens/new?description=Swep+Vault+Access&scopes=public_repo') {
  const chromeExe = await findChromePath();
  if (!chromeExe) {
    throw new Error('Không tìm thấy Google Chrome trên máy.');
  }

  const tempAuthProfile = path.join(process.env.TEMP || 'C:\\Temp', `swep-auth-${Date.now()}`);
  if (!fs.existsSync(tempAuthProfile)) {
    fs.mkdirSync(tempAuthProfile, { recursive: true });
  }

  const args = [
    `--user-data-dir=${tempAuthProfile}`,
    '--no-first-run',
    '--no-default-browser-check',
    targetUrl,
  ];

  const child = spawn(chromeExe, args, {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  return child;
}

/**
 * Tìm và đóng các tiến trình Chrome ĐANG DÙNG profile của Swep
 * Tuyệt đối không đóng tiến trình Chrome của người dùng chính
 * @param {string} rootDir
 * @returns {Promise<number>} Số tiến trình đã đóng
 */
export async function killSwepChromeProcesses(rootDir) {
  const profileDir = path.join(rootDir, 'chrome-profile');
  const normalizedProfileDir = profileDir.replace(/\\/g, '\\\\');

  let killedCount = 0;

  try {
    // Sử dụng PowerShell để lọc chính xác tiến trình có CommandLine chứa profileDir của Swep
    const psCommand = `Get-CimInstance Win32_Process -Filter "name = 'chrome.exe'" | Where-Object { $_.CommandLine -like "*${normalizedProfileDir}*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force; $_.ProcessId }`;
    const { stdout } = await execAsync(`powershell -NoProfile -Command "${psCommand}"`);
    const pids = stdout.trim().split(/\r?\n/).filter(Boolean);
    killedCount = pids.length;
  } catch (err) {
    // Lỗi có thể xảy ra nếu không có tiến trình nào khớp
  }

  return killedCount;
}

/**
 * Copy chuỗi vào clipboard và tự động xóa sau `timeoutSec` giây
 * @param {string} text
 * @param {number} [timeoutSec=25]
 */
export async function copyToClipboardWithAutoClear(text, timeoutSec = 25) {
  try {
    const escapedText = text.replace(/`/g, '``').replace(/"/g, '`"').replace(/\$/g, '`$');
    await execAsync(`powershell -NoProfile -Command "Set-Clipboard -Value \\"${escapedText}\\""`);

    // Hẹn giờ tự xóa clipboard
    setTimeout(async () => {
      try {
        await execAsync('powershell -NoProfile -Command "Set-Clipboard -Value \\"\\""');
      } catch {
        // ignore
      }
    }, timeoutSec * 1000).unref();
  } catch {
    // Không làm gián đoạn luồng chính nếu clipboard lỗi
  }
}

/**
 * Đọc nội dung hiện tại từ clipboard Windows
 * @returns {Promise<string>}
 */
export async function getClipboardText() {
  try {
    const { stdout } = await execAsync('powershell -NoProfile -Command "Get-Clipboard"');
    return stdout.trim();
  } catch {
    return '';
  }
}
