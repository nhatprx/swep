/**
 * Command: login / up (default command)
 * Đăng nhập bằng mã: Tải vault từ GitHub của user (Zero-Server Architecture),
 * giải mã, tự động nạp Session Capsule qua CDP (nếu đã có) và mở Chrome với profile cô lập
 */

import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import {
  printBanner,
  prompt,
  promptConfirm,
  createSpinner,
} from '../ui.js';
import { registerCommand } from './register.js';
import {
  deriveSeed,
  hkdf,
  aead_decrypt,
  normalizeCode,
} from '../crypto.js';
import { fetchVault, fetchProfileCapsuleFromGitHub } from '../vault.js';
import { defaultGate } from '../gate.js';
import {
  findChromePath,
  installChromeViaWinget,
  launchIsolatedChrome,
  openSwepChrome,
  getSwepRoot,
} from '../chrome.js';
import {
  saveActiveSession,
} from '../bridge.js';
import {
  getFreePort,
  injectCookiesViaCDP,
  navigatePageViaCDP,
} from '../cdp.js';
import {
  decryptCapsule,
  unpackProfileDirectory,
  adaptProfileForCurrentMachine,
} from '../profile.js';
import {
  takeBeforeSnapshot,
  recordLedger,
} from '../cleanup.js';

export async function loginCommand(codeOrOptions, maybeOptions = {}) {
  let passedCode = typeof codeOrOptions === 'string' ? codeOrOptions : null;
  let options = typeof codeOrOptions === 'object' && codeOrOptions !== null ? codeOrOptions : (maybeOptions || {});

  const rootDir = getSwepRoot(options.root);

  if (options.dryRun) {
    console.log('[dry-run] Simulating workspace launch...');
  }

  // If no code provided and active profile exists: reopen Chrome
  const existingProfileDir = path.join(rootDir, 'chrome-profile');
  if (!passedCode && fs.existsSync(existingProfileDir)) {
    const opened = await openSwepChrome(rootDir, 'https://www.google.com');
    if (opened) {
      console.log("Workspace reopened. Run 'swep exit' when done.");
      return;
    }
  }

  // Require login code
  let inputCode = passedCode;
  if (!inputCode) {
    console.error("usage: swep <code>");
    console.error("error: login code is required");
    return;
  }

  const parts = inputCode.trim().split('-');
  if (parts.length < 2) {
    console.error('error: invalid code format (expected: <username>-<code>)');
    return;
  }

  const handle = parts[0].toLowerCase();
  const rawCode = parts.slice(1).join('-');
  const normalizedCode = normalizeCode(rawCode);

  let userPayload;
  let dekBuffer;
  let vaultData;

  // 1. Fetch and decrypt vault
  try {
    vaultData = await fetchVault(handle);
    const seed = await deriveSeed(normalizedCode, handle);
    const codeKey = hkdf(seed, 'swep/wrap');

    const dekObj = aead_decrypt(codeKey, vaultData.wrap_code, `${handle}/code`);
    dekBuffer = Buffer.from(dekObj.dek, 'hex');
    userPayload = aead_decrypt(dekBuffer, vaultData.payload, `${handle}/1`);
  } catch (vaultErr) {
    try {
      const seed = await deriveSeed(normalizedCode, handle);
      const authKey = hkdf(seed, 'swep/auth');
      const codeKey = hkdf(seed, 'swep/wrap');

      const loginRes = await defaultGate.login(handle, authKey.toString('hex'));
      const dekObj = aead_decrypt(codeKey, loginRes.wrap_code, `${handle}/code`);
      dekBuffer = Buffer.from(dekObj.dek, 'hex');
      userPayload = aead_decrypt(dekBuffer, loginRes.payload, `${handle}/1`);
      vaultData = loginRes;
    } catch {
      console.error(`error: authentication failed (${vaultErr.message})`);
      return;
    }
  }

  // 2. Ensure Google Chrome is installed
  let chromeExe = await findChromePath();
  let preexistingChrome = true;

  if (!chromeExe) {
    process.stdout.write('Installing Google Chrome via winget... ');
    const installed = await installChromeViaWinget();
    if (installed) {
      chromeExe = await findChromePath();
      preexistingChrome = false;
      console.log('done.');
    } else {
      console.log('failed.');
    }
  }

  if (!chromeExe) {
    console.error('error: Google Chrome is required. Please install Google Chrome.');
    return;
  }

  // 3. Snapshot & Ledger
  takeBeforeSnapshot(rootDir, {
    handle,
    email: userPayload.google_email || handle,
    chromeExe,
  });

  recordLedger(rootDir, {
    action: preexistingChrome ? 'use_chrome' : 'install_chrome',
    preexisting: preexistingChrome,
    chromeExe,
  });

  // 4. Restore Profile Capsule if available
  const profileDir = path.join(rootDir, 'chrome-profile');
  let initialCookies = (userPayload.session && Array.isArray(userPayload.session.cookies))
    ? userPayload.session.cookies
    : [];
  let restoredCapsule = false;

  try {
    const encCapsule = await fetchProfileCapsuleFromGitHub(handle);
    if (encCapsule) {
      const rawGz = decryptCapsule(encCapsule, dekBuffer, `${handle}/capsule/v2`);
      const { manifest } = unpackProfileDirectory(rawGz, profileDir);
      await adaptProfileForCurrentMachine(profileDir, manifest);

      if (manifest.session_cookies && Array.isArray(manifest.session_cookies) && manifest.session_cookies.length) {
        initialCookies = manifest.session_cookies;
      }
      if (manifest.google_password) {
        userPayload.google_password = manifest.google_password;
      }
      restoredCapsule = true;
    }
  } catch {
    // continue with fallback
  }

  const cdpPort = await getFreePort();
  const targetUrl = (initialCookies.length || restoredCapsule) ? 'https://www.google.com' : 'https://accounts.google.com';

  saveActiveSession(rootDir, {
    handle,
    google_email: userPayload.google_email || handle,
    google_password: userPayload.google_password || '',
    github_pat: userPayload.github_pat,
    dek: dekBuffer.toString('hex'),
    wrap_code: vaultData.wrap_code,
    wrap_recovery: vaultData.wrap_recovery,
    cdpPort,
    userPayload,
  });

  // 5. Launch Chrome
  if (restoredCapsule) {
    await launchIsolatedChrome(chromeExe, rootDir, targetUrl, cdpPort);
  } else if (initialCookies.length > 0) {
    await launchIsolatedChrome(chromeExe, rootDir, 'about:blank', cdpPort);
    try {
      await injectCookiesViaCDP(cdpPort, initialCookies);
      await navigatePageViaCDP(cdpPort, targetUrl);
    } catch {
      await openSwepChrome(rootDir, targetUrl, cdpPort);
    }
  } else {
    await launchIsolatedChrome(chromeExe, rootDir, targetUrl, cdpPort);
  }

  const account = userPayload.google_email || handle;
  console.log(`Workspace ready for ${account}. Run 'swep exit' when done.`);
}
