/**
 * Watchdog Service
 * Automatically checks out the active key and purges sensitive profile data
 * if the terminal or parent process is abruptly closed/terminated.
 */

import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { readActiveSession, removeActiveSession } from './bridge.js';
import { killSwepBrowserProcesses } from './chrome.js';
import { performCleanup } from './cleanup.js';
import { closeChromeViaCDP } from './cdp.js';
import { packProfileDirectory, encryptCapsule } from './profile.js';
import { uploadVaultToGitHub, uploadProfileCapsuleToGitHub } from './vault.js';
import { aead_encrypt } from './crypto.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const cliEntry = path.resolve(__dirname, '../bin/swep.js');

/**
 * Spawns a background watchdog watching the terminal process PID
 * @param {string} rootDir
 * @param {number} terminalPid
 */
export function spawnWatchdog(rootDir, terminalPid) {
  const pidNum = Number(terminalPid);
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
 * Silently checkout session without user interaction
 * @param {string} rootDir
 */
export async function silentCheckout(rootDir) {
  const activeSession = readActiveSession(rootDir);
  if (!activeSession) return;

  const profileDir = path.join(rootDir, 'chrome-profile');

  // Close browser
  if (activeSession.cdpPort) {
    try {
      await closeChromeViaCDP(activeSession.cdpPort);
    } catch {
      // ignore
    }
  }
  await killSwepBrowserProcesses(rootDir);

  // Sync capsule if possible (with 8s timeout safeguard)
  if (activeSession.github_pat && fs.existsSync(profileDir)) {
    try {
      await Promise.race([
        (async () => {
          const metadata = {
            handle: activeSession.handle,
            google_email: activeSession.google_email || activeSession.userPayload?.google_email,
            google_password: activeSession.google_password || activeSession.userPayload?.google_password,
            session_cookies: activeSession.userPayload?.session?.cookies || [],
          };
          const gzArchive = await packProfileDirectory(profileDir, metadata);
          const dek = Buffer.from(activeSession.dek, 'hex');
          const encryptedCapsule = encryptCapsule(gzArchive, dek, `${activeSession.handle}/capsule/v2`);
          const targetRepo = activeSession.vaultRepo || 'swep-vault';
          await uploadProfileCapsuleToGitHub(activeSession.github_pat, activeSession.handle, encryptedCapsule, targetRepo);

          const userPayload = activeSession.userPayload || {};
          userPayload.session = {
            cookies: metadata.session_cookies,
            capsule_size: encryptedCapsule.length,
            updated_at: new Date().toISOString(),
          };
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
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 8000)),
      ]);
    } catch {
      // ignore
    }
  }

  // Wipe profile, keeping swep installed
  await performCleanup(rootDir, { selfDestruct: false });
  removeActiveSession(rootDir);
}

function cleanupWatchdogPid(rootDir) {
  const watchdogPidFile = path.join(rootDir, 'watchdog.pid');
  try {
    if (fs.existsSync(watchdogPidFile)) fs.unlinkSync(watchdogPidFile);
  } catch {
    // ignore
  }
}
