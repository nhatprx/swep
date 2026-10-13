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
 * @param {number} [cdpPort]
 * @returns {Promise<import('child_process').ChildProcess>}
 */
export async function launchIsolatedChrome(chromeExe, rootDir, targetUrl = 'https://accounts.google.com', cdpPort = 0) {
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

  const child = spawn(chromeExe, args, {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  return child;
}

/**
 * Mở lại cửa sổ Chrome của Swep với profile cô lập
 * @param {string} rootDir
 * @param {string} [targetUrl]
 * @param {number} [cdpPort]
 * @returns {Promise<boolean>}
 */
export async function openSwepChrome(rootDir, targetUrl = 'https://myaccount.google.com', cdpPort = 0) {
  const chromeExe = await findChromePath();
  if (!chromeExe) {
    throw new Error('Không tìm thấy Google Chrome trên máy.');
  }
  const profileDir = path.join(rootDir, 'chrome-profile');
  if (!fs.existsSync(profileDir)) {
    return false;
  }
  await launchIsolatedChrome(chromeExe, rootDir, targetUrl, cdpPort);
  return true;
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
  let killedCount = 0;

  try {
    const psScript = `
$procs = Get-CimInstance Win32_Process -Filter "name = 'chrome.exe'" | Where-Object { $_.CommandLine -like '*chrome-profile*' }
foreach ($p in $procs) {
    try {
        taskkill /PID $p.ProcessId /T /F | Out-Null
        $p.ProcessId
    } catch {}
}
`;
    const b64 = Buffer.from(psScript, 'utf16le').toString('base64');
    const { stdout } = await execAsync(`powershell -NoProfile -EncodedCommand ${b64}`);
    const pids = stdout.trim().split(/\r?\n/).filter((l) => /^\d+$/.test(l.trim()));
    killedCount = pids.length;

    // Chờ tối đa 5s cho đến khi toàn bộ tiến trình Chrome của Swep tắt hẳn
    for (let i = 0; i < 10; i++) {
      const checkScript = `(Get-CimInstance Win32_Process -Filter "name = 'chrome.exe'" | Where-Object { $_.CommandLine -like '*chrome-profile*' }).Count`;
      const b64Check = Buffer.from(checkScript, 'utf16le').toString('base64');
      const { stdout: checkOut } = await execAsync(`powershell -NoProfile -EncodedCommand ${b64Check}`);
      const remaining = parseInt(checkOut.trim(), 10) || 0;
      if (remaining === 0) break;
      await new Promise((r) => setTimeout(r, 400));
    }
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

/**
 * Tự động điền email, mật khẩu và mã 2FA vào trang Google trên Chrome
 * Sử dụng SendKeys và Clipboard an toàn để không bị Google chặn bot
 * @param {string} email
 * @param {string} password
 * @param {string} [totp]
 * @param {(step: string) => void} [onProgress]
 * @returns {Promise<boolean>}
 */
export async function autoFillGoogleLogin(email, password, totp = '', onProgress = () => {}) {
  const tempScriptPath = path.join(process.env.TEMP || 'C:\\Temp', `swep-autofill-${Date.now()}.ps1`);
  const escapedEmail = (email || '').replace(/"/g, '`"');
  const escapedPassword = (password || '').replace(/"/g, '`"').replace(/\$/g, '`$');
  const escapedTotp = (totp || '').replace(/"/g, '`"');

  const psScript = `
Add-Type -AssemblyName System.Windows.Forms
$wshell = New-Object -ComObject wscript.shell

function Send-Paste {
    param([string]$Text)
    for ($i = 0; $i -lt 5; $i++) {
        try {
            [System.Windows.Forms.Clipboard]::SetText($Text)
            break
        } catch {
            Start-Sleep -Milliseconds 150
        }
    }
    Start-Sleep -Milliseconds 300
    # Kích hoạt lại Chrome trước khi dán
    $wshell.AppActivate('Google')
    $wshell.AppActivate('Chrome')
    Start-Sleep -Milliseconds 300
    [System.Windows.Forms.SendKeys]::SendWait('^v')
    Start-Sleep -Milliseconds 500
    [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
}

# 1. Chờ Chrome khởi động và tải hoàn tất trang đăng nhập Google
Start-Sleep -Seconds 6

# 2. Điền Email
Send-Paste -Text "${escapedEmail}"

# 3. Chờ Google xác nhận email và chuyển sang trang mật khẩu
Start-Sleep -Seconds 4
Send-Paste -Text "${escapedPassword}"

# 4. Chờ trang xác thực 2FA TOTP nếu có
if ("${escapedTotp}") {
    Start-Sleep -Seconds 4
    Send-Paste -Text "${escapedTotp}"
}

# 5. Xóa sạch clipboard sau khi hoàn tất
Start-Sleep -Seconds 2
[System.Windows.Forms.Clipboard]::Clear()
`;

  try {
    onProgress('Đang chờ trang đăng nhập Google tải (4s)...');
    fs.writeFileSync(tempScriptPath, psScript, 'utf8');
    await execAsync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${tempScriptPath}"`);
    fs.unlinkSync(tempScriptPath);
    return true;
  } catch {
    try {
      if (fs.existsSync(tempScriptPath)) fs.unlinkSync(tempScriptPath);
    } catch {
      // ignore
    }
    return false;
  }
}
