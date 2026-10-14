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
/**
 * Supported Chromium-based browsers on Windows
 */
const BROWSER_DEFINITIONS = [
  {
    id: 'chrome',
    name: 'Google Chrome',
    exec: 'chrome.exe',
    paths: [
      path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(process.env.LOCALAPPDATA || 'C:\\Users\\Default\\AppData\\Local', 'Google\\Chrome\\Application\\chrome.exe'),
    ],
  },
  {
    id: 'edge',
    name: 'Microsoft Edge',
    exec: 'msedge.exe',
    paths: [
      path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Microsoft\\Edge\\Application\\msedge.exe'),
      path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Microsoft\\Edge\\Application\\msedge.exe'),
      path.join(process.env.LOCALAPPDATA || 'C:\\Users\\Default\\AppData\\Local', 'Microsoft\\Edge\\Application\\msedge.exe'),
    ],
  },
  {
    id: 'brave',
    name: 'Brave Browser',
    exec: 'brave.exe',
    paths: [
      path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'BraveSoftware\\Brave-Browser\\Application\\brave.exe'),
      path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'BraveSoftware\\Brave-Browser\\Application\\brave.exe'),
      path.join(process.env.LOCALAPPDATA || 'C:\\Users\\Default\\AppData\\Local', 'BraveSoftware\\Brave-Browser\\Application\\brave.exe'),
    ],
  },
  {
    id: 'vivaldi',
    name: 'Vivaldi',
    exec: 'vivaldi.exe',
    paths: [
      path.join(process.env.LOCALAPPDATA || 'C:\\Users\\Default\\AppData\\Local', 'Vivaldi\\Application\\vivaldi.exe'),
      path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Vivaldi\\Application\\vivaldi.exe'),
    ],
  },
  {
    id: 'opera',
    name: 'Opera',
    exec: 'opera.exe',
    paths: [
      path.join(process.env.LOCALAPPDATA || 'C:\\Users\\Default\\AppData\\Local', 'Programs\\Opera\\opera.exe'),
      path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Opera\\opera.exe'),
    ],
  },
];

/**
 * Get Swep root directory (%LOCALAPPDATA%\Swep)
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
 * Find available browser executable on Windows (Chrome, Edge, Brave, etc.)
 * @param {string} [preferred]
 * @returns {Promise<string|null>}
 */
export async function findBrowserPath(preferred = '') {
  let list = BROWSER_DEFINITIONS;
  if (preferred) {
    const prefNorm = preferred.toLowerCase();
    const foundPref = BROWSER_DEFINITIONS.find((b) => b.id === prefNorm || b.name.toLowerCase().includes(prefNorm));
    if (foundPref) {
      list = [foundPref, ...BROWSER_DEFINITIONS.filter((b) => b.id !== foundPref.id)];
    }
  }

  for (const b of list) {
    for (const p of b.paths) {
      if (fs.existsSync(p)) {
        return p;
      }
    }
  }

  // Fallback to PATH commands
  for (const b of list) {
    try {
      const { stdout } = await execAsync(`where ${b.id}`);
      const firstLine = stdout.trim().split(/\r?\n/)[0];
      if (firstLine && fs.existsSync(firstLine)) {
        return firstLine;
      }
    } catch {
      // ignore
    }
  }

  return null;
}

export const findChromePath = findBrowserPath;

/**
 * Install Google Chrome via winget (if no browser available)
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
 * Launch isolated browser with dedicated user profile
 * @param {string} browserExe
 * @param {string} rootDir
 * @param {string} [targetUrl]
 * @param {number} [cdpPort]
 * @returns {Promise<import('child_process').ChildProcess>}
 */
export async function launchIsolatedBrowser(browserExe, rootDir, targetUrl = 'https://accounts.google.com', cdpPort = 0) {
  const profileDir = path.join(rootDir, 'chrome-profile');
  if (!fs.existsSync(profileDir)) {
    fs.mkdirSync(profileDir, { recursive: true });
  }

  const args = [
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-signin-promo',
    '--disable-sync',
    '--disable-features=DeviceBoundSessions,EnableBoundSessionCredentials,DeviceBoundSessionsFederatedRegistration',
  ];

  if (cdpPort) {
    args.push(`--remote-debugging-port=${cdpPort}`);
  }

  args.push(targetUrl);

  const child = spawn(browserExe, args, {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  return child;
}

export const launchIsolatedChrome = launchIsolatedBrowser;

/**
 * Reopen active workspace browser window
 * @param {string} rootDir
 * @param {string} [targetUrl]
 * @param {number} [cdpPort]
 * @returns {Promise<boolean>}
 */
export async function openSwepBrowser(rootDir, targetUrl = 'https://myaccount.google.com', cdpPort = 0) {
  const browserExe = await findBrowserPath();
  if (!browserExe) {
    throw new Error('No supported browser found.');
  }
  const profileDir = path.join(rootDir, 'chrome-profile');
  if (!fs.existsSync(profileDir)) {
    return false;
  }
  await launchIsolatedBrowser(browserExe, rootDir, targetUrl, cdpPort);
  return true;
}

export const openSwepChrome = openSwepBrowser;

/**
 * Open a clean browser window for GitHub setup
 * @param {string} targetUrl
 * @returns {Promise<import('child_process').ChildProcess>}
 */
export async function openCleanBrowserForGitHub(targetUrl = 'https://github.com/settings/tokens/new?description=Swep+Vault+Access&scopes=public_repo') {
  const browserExe = await findBrowserPath();
  if (!browserExe) {
    throw new Error('No supported browser found.');
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

  const child = spawn(browserExe, args, {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  return child;
}

/**
 * Executes a PowerShell script directly via spawn with CREATE_NO_WINDOW
 * Guaranteed to NEVER spawn any console window (conhost.exe) on Windows.
 * @param {string} script
 * @returns {Promise<string>}
 */
export function runHiddenPowerShell(script) {
  return new Promise((resolve) => {
    const b64 = Buffer.from(script, 'utf16le').toString('base64');
    const child = spawn('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      b64,
    ], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });

    let stdout = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.on('close', () => {
      resolve(stdout.trim());
    });
    child.on('error', () => resolve(''));
  });
}

/**
 * Kill active isolated Swep browser processes (Chrome, Edge, Brave, etc.)
 * Does not terminate the host user's personal browsers
 * @param {string} rootDir
 * @returns {Promise<number>}
 */
export async function killSwepBrowserProcesses(rootDir) {
  let killedCount = 0;

  try {
    const escapedRoot = rootDir ? rootDir.replace(/'/g, "''") : 'chrome-profile';
    const psScript = `
$targetNames = @('chrome.exe', 'msedge.exe', 'brave.exe', 'opera.exe', 'vivaldi.exe')
$procs = Get-CimInstance Win32_Process | Where-Object { ($_.Name -in $targetNames) -and ($_.CommandLine -like '*${escapedRoot}*' -or $_.CommandLine -like '*chrome-profile*') }

foreach ($p in $procs) {
    try {
        Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
        $p.ProcessId
    } catch {}
}
`;
    const stdout = await runHiddenPowerShell(psScript);
    const pids = stdout.split(/\r?\n/).filter((l) => /^\d+$/.test(l.trim()));
    killedCount = pids.length;
  } catch {
    // ignore
  }

  return killedCount;
}

export const killSwepChromeProcesses = killSwepBrowserProcesses;

/**
 * Copy chuỗi vào clipboard và tự động xóa sau `timeoutSec` giây
 * @param {string} text
 * @param {number} [timeoutSec=25]
 */
export async function copyToClipboardWithAutoClear(text, timeoutSec = 25) {
  try {
    const escapedText = text.replace(/`/g, '``').replace(/"/g, '`"').replace(/\$/g, '`$');
    await runHiddenPowerShell(`Set-Clipboard -Value "${escapedText}"`);

    // Hẹn giờ tự xóa clipboard
    setTimeout(async () => {
      try {
        await runHiddenPowerShell('Set-Clipboard -Value ""');
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
    const stdout = await runHiddenPowerShell('Get-Clipboard');
    return stdout.trim();
  } catch {
    return '';
  }
}
