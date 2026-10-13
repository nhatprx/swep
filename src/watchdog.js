/**
 * Watchdog Service
 * Automatically checks out the active key and purges sensitive profile data
 * if the terminal or parent process is abruptly closed/terminated.
 */

import fs from 'fs';
import path from 'path';
import { spawn, execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { readActiveSession, removeActiveSession } from './bridge.js';
import { killSwepBrowserProcesses } from './chrome.js';
import { performCleanup } from './cleanup.js';
import { closeChromeViaCDP, getCookiesViaCDP } from './cdp.js';
import { packProfileDirectory, encryptCapsule } from './profile.js';
import { uploadVaultToGitHub, uploadProfileCapsuleToGitHub } from './vault.js';
import { aead_encrypt } from './crypto.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const cliEntry = path.resolve(__dirname, '../bin/swep.js');

let isCheckingOut = false;

/**
 * Resolves the persistent interactive shell / terminal PID from a potentially transient runner PID
 * @param {number} [initialPid]
 * @returns {number}
 */
export function getInteractiveTerminalPid(initialPid = process.ppid) {
  try {
    const pidNum = Number(initialPid);
    if (!pidNum || pidNum <= 0) return initialPid;

    const script = `
$pidNum = ${pidNum}
$proc = Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -eq $pidNum }
if ($proc) {
    if ($proc.Name -like 'cmd.exe' -and ($proc.CommandLine -like '* /c *' -or $proc.CommandLine -like '* /d /c *')) {
        $parent = Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -eq $proc.ParentProcessId }
        if ($parent) {
            $parent.ProcessId
            exit
        }
    }
    $proc.ProcessId
}
`;
    const b64 = Buffer.from(script, 'utf16le').toString('base64');
    const out = execSync(`powershell -NoProfile -WindowStyle Hidden -NonInteractive -EncodedCommand ${b64}`, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString();
    const clean = out.trim().split(/\r?\n/).filter((l) => /^\d+$/.test(l.trim())).pop();
    if (clean) return parseInt(clean, 10);
  } catch {
    // fallback to initialPid
  }
  return initialPid;
}

/**
 * Spawns a background watchdog watching the terminal process PID
 * @param {string} rootDir
 * @param {number} terminalPid
 */
export function spawnWatchdog(rootDir, terminalPid) {
  const resolvedPid = getInteractiveTerminalPid(terminalPid);
  const pidNum = Number(resolvedPid);
  if (!pidNum || pidNum <= 0) return;

  const watchdogPidFile = path.join(rootDir, 'watchdog.pid');
  if (fs.existsSync(watchdogPidFile)) {
    try {
      const existingPid = parseInt(fs.readFileSync(watchdogPidFile, 'utf8'), 10);
      if (existingPid > 0) {
        process.kill(existingPid, 0);
        // Watchdog is already running and alive
        return;
      }
    } catch {
      // Process is not alive, proceed with fresh spawn
    }
  }

  try {
    const child = spawn(process.execPath, [cliEntry, '_watchdog', String(pidNum), rootDir], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    if (child.pid) {
      try {
        fs.writeFileSync(watchdogPidFile, String(child.pid), 'utf8');
      } catch {
        // ignore
      }
      child.unref();
    }
  } catch {
    // ignore
  }
}

/**
 * Main watchdog loop executing in detached process
 * @param {string|number} terminalPid
 * @param {string} rootDir
 */
export async function runWatchdog(terminalPid, rootDir) {
  const pidNum = Number(terminalPid);
  if (!pidNum || pidNum <= 0) process.exit(0);

  const check = async () => {
    // 1. Check if an active session still exists
    const session = readActiveSession(rootDir);
    if (!session) {
      cleanupWatchdogPid(rootDir);
      process.exit(0);
    }

    // 2. Check if terminal parent process is still alive
    let alive = true;
    try {
      process.kill(pidNum, 0);
    } catch {
      alive = false;
    }

    if (!alive) {
      // Terminal terminated abruptly! Trigger auto-checkout
      try {
        await silentCheckout(rootDir);
      } catch {
        try {
          await performCleanup(rootDir, { selfDestruct: false });
        } catch {
          // ignore
        }
      }
      cleanupWatchdogPid(rootDir);
      process.exit(0);
    }
  };

  const timer = setInterval(check, 1500);

  // Keep process alive
  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));
}

/**
 * Silently checkout session without user interaction:
 * Captures live cookies via CDP, gracefully terminates browser with zero console flashes,
 * uploads encrypted profile capsule to GitHub, and wipes local profile.
 * @param {string} rootDir
 */
export async function silentCheckout(rootDir) {
  if (isCheckingOut) return;
  isCheckingOut = true;

  const activeSession = readActiveSession(rootDir);
  if (!activeSession) {
    isCheckingOut = false;
    return;
  }

  const lockFile = path.join(rootDir, 'checkout.lock');
  if (fs.existsSync(lockFile)) {
    isCheckingOut = false;
    return;
  }

  try {
    fs.writeFileSync(lockFile, String(process.pid), 'utf8');
  } catch {
    // ignore
  }

  try {
    // 1. Thu thập live cookies từ Chrome qua CDP TRƯỚC KHI đóng
    let latestCookies = [];

    if (activeSession.cdpPort) {
      try {
        const cdpCookies = await getCookiesViaCDP(activeSession.cdpPort);
        if (Array.isArray(cdpCookies) && cdpCookies.length > 0) {
          latestCookies = cdpCookies;
        }
      } catch {
        // Chrome có thể đã đóng trước
      }
    }

    if (latestCookies.length === 0) {
      const backupFile = path.join(rootDir, 'latest-cookies.json');
      if (fs.existsSync(backupFile)) {
        try {
          const saved = JSON.parse(fs.readFileSync(backupFile, 'utf8'));
          if (Array.isArray(saved) && saved.length > 0) {
            latestCookies = saved;
          }
        } catch {
          // ignore
        }
      }
    }

    // Merge cookies an toàn: giữ lại auth cookies nếu phiên hiện tại bị thiếu
    let finalCookies = latestCookies;
    const existingCookies = activeSession.userPayload?.session?.cookies || [];
    const hasAuthCookies = (list) =>
      Array.isArray(list) &&
      list.some(
        (c) =>
          (c.name === 'SID' || c.name === 'HSID' || c.name === 'SSID' || c.name === '__Secure-1PSID') &&
          c.domain &&
          c.domain.includes('google')
      );

    if (!hasAuthCookies(latestCookies) && hasAuthCookies(existingCookies)) {
      const latestMap = new Map(latestCookies.map((c) => [`${c.name}@${c.domain}`, c]));
      for (const old of existingCookies) {
        const key = `${old.name}@${old.domain}`;
        if (!latestMap.has(key)) {
          latestMap.set(key, old);
        }
      }
      finalCookies = Array.from(latestMap.values());
    }

    // 2. Đóng Chrome nhẹ nhàng qua CDP trước để flush sạch LevelDB / SQLite xuống đĩa
    if (activeSession.cdpPort) {
      try {
        await closeChromeViaCDP(activeSession.cdpPort);
        await new Promise((r) => setTimeout(r, 1500));
      } catch {
        // ignore
      }
    }

    // 3. Tắt sạch các tiến trình browser con của Swep hoàn toàn trong im lặng (không conhost/flashing window)
    await killSwepBrowserProcesses(rootDir);
    await new Promise((r) => setTimeout(r, 1000));

    // 4. Đóng gói profile capsule và upload lên GitHub repo
    const profileDir = path.join(rootDir, 'chrome-profile');
    if (activeSession.github_pat && fs.existsSync(profileDir)) {
      try {
        await Promise.race([
          (async () => {
            const metadata = {
              handle: activeSession.handle,
              google_email: activeSession.google_email || activeSession.userPayload?.google_email,
              google_password: activeSession.google_password || activeSession.userPayload?.google_password,
              session_cookies: finalCookies,
            };
            const gzArchive = await packProfileDirectory(profileDir, metadata);
            const dek = Buffer.from(activeSession.dek, 'hex');
            const encryptedCapsule = encryptCapsule(gzArchive, dek, `${activeSession.handle}/capsule/v2`);
            const targetRepo = activeSession.vaultRepo || 'swep-vault';
            await uploadProfileCapsuleToGitHub(activeSession.github_pat, activeSession.handle, encryptedCapsule, targetRepo);

            const userPayload = activeSession.userPayload || {};
            userPayload.session = {
              cookies: finalCookies,
              capsule_size: encryptedCapsule.length,
              updated_at: new Date().toISOString(),
            };
            if (activeSession.google_email) userPayload.google_email = activeSession.google_email;
            if (activeSession.google_password) userPayload.google_password = activeSession.google_password;

            const encryptedPayload = aead_encrypt(dek, userPayload, `${activeSession.handle}/1`);
            const vaultData = {
              handle: activeSession.handle,
              version: 2,
              wrap_code: activeSession.wrap_code,
              wrap_recovery: activeSession.wrap_recovery,
              payload: encryptedPayload,
              updated_at: new Date().toISOString(),
            };
            await uploadVaultToGitHub(activeSession.github_pat, activeSession.handle, vaultData, targetRepo);
          })(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 30000)),
        ]);
      } catch {
        // ignore upload failure in silent checkout
      }
    }

    // 5. Xóa profile để giữ an toàn cho key, nhưng GIỮ LẠI core swep (selfDestruct: false)
    await performCleanup(rootDir, { selfDestruct: false });
    removeActiveSession(rootDir);
  } finally {
    try {
      if (fs.existsSync(lockFile)) fs.unlinkSync(lockFile);
    } catch {
      // ignore
    }
    isCheckingOut = false;
  }
}

function cleanupWatchdogPid(rootDir) {
  const watchdogPidFile = path.join(rootDir, 'watchdog.pid');
  try {
    if (fs.existsSync(watchdogPidFile)) fs.unlinkSync(watchdogPidFile);
  } catch {
    // ignore
  }
}
