import fs from 'fs';
import path from 'path';
import ora from 'ora';
import {
  deriveSeed,
  hkdf,
  aead_decrypt,
  normalizeCode,
} from '../crypto.js';
import { fetchVault, fetchProfileCapsuleFromGitHub } from '../vault.js';
import { defaultGate } from '../gate.js';
import {
  findBrowserPath,
  installChromeViaWinget,
  launchIsolatedBrowser,
  openSwepBrowser,
  getSwepRoot,
} from '../chrome.js';
import chalk from 'chalk';
import { promptSecret } from '../ui.js';
import {
  saveActiveSession,
  readActiveSession,
  getActiveKey,
  maskKey,
} from '../bridge.js';
import { spawnWatchdog } from '../watchdog.js';
import { checkoutCommand } from './checkout.js';
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

  const activeSession = readActiveSession(rootDir);
  const existingProfileDir = path.join(rootDir, 'chrome-profile');

  // If no code provided
  if (!passedCode) {
    const active = getActiveKey(rootDir);
    if (active) {
      console.log(chalk.dim('key-id: ') + chalk.cyan(active.maskedKey) + chalk.dim(' (active)'));
      console.log("Workspace active. Run 'swep open' to view browser, 'swep checkout' to switch key, or 'swep exit' to clean and exit.\n");
      return;
    }

    const entered = await promptSecret('Enter login code (e.g. nhatprx-8GBA-142B-DW, or "exit" to cancel)');
    if (!entered || entered.trim().toLowerCase() === 'exit' || entered.trim().toLowerCase() === 'q') {
      return;
    }
    passedCode = entered.trim();
  }

  // Require login code
  let inputCode = passedCode.trim();

  const parts = inputCode.split('-');
  if (parts.length < 2 || !parts[0] || !parts[1]) {
    console.error(`error: invalid code format '${inputCode}' (expected: <username>-<code>)`);
    console.error("Run 'swep --help' for available commands.\n");
    return;
  }

  const handle = parts[0].toLowerCase();
  const rawCode = parts.slice(1).join('-');
  const normalizedCode = normalizeCode(rawCode);

  const spinner = ora({
    text: 'Fetching workspace vault...',
    color: 'cyan',
    spinner: 'dots',
  }).start();

  let userPayload;
  let dekBuffer;
  let vaultData;

  // 1. Fetch and decrypt vault
  try {
    vaultData = await fetchVault(handle);
    spinner.text = 'Deriving encryption keys...';

    const seed = await deriveSeed(normalizedCode, handle, vaultData.salt || null);
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
      spinner.stop();
      console.error(`error: authentication failed (${vaultErr.message})`);
      return;
    }
  }

  // If authenticated and switching from a previous active key, check out the previous one
  if (activeSession && activeSession.loginCode && activeSession.loginCode !== inputCode) {
    spinner.stop();
    console.log(chalk.dim('Switching keys. Checking out current key: ') + chalk.cyan(maskKey(activeSession.loginCode)) + chalk.dim('...'));
    await checkoutCommand({ root: options.root });
    spinner.start('Launching new workspace...');
  }

  // 2. Detect browser (Chrome, Edge, Brave, etc.)
  spinner.text = 'Detecting browser environment...';
  let browserExe = await findBrowserPath(options.browser);
  let preexistingBrowser = true;

  if (!browserExe) {
    spinner.text = 'Installing Google Chrome via winget...';
    const installed = await installChromeViaWinget();
    if (installed) {
      browserExe = await findBrowserPath();
      preexistingBrowser = false;
    }
  }

  if (!browserExe) {
    spinner.stop();
    console.error('error: no supported browser found (Chrome, Edge, Brave).');
    return;
  }

  // 3. Snapshot & Ledger
  takeBeforeSnapshot(rootDir, {
    handle,
    email: userPayload.google_email || handle,
    browserExe,
  });

  recordLedger(rootDir, {
    action: preexistingBrowser ? 'use_browser' : 'install_browser',
    preexisting: preexistingBrowser,
    browserExe,
  });

  // 4. Restore Profile Capsule if available
  spinner.text = 'Restoring workspace session...';
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
    vaultRepo: vaultData._repo || 'swep-vault',
    loginCode: inputCode,
    google_email: userPayload.google_email || handle,
    google_password: userPayload.google_password || '',
    github_pat: userPayload.github_pat,
    dek: dekBuffer.toString('hex'),
    wrap_code: vaultData.wrap_code,
    wrap_recovery: vaultData.wrap_recovery,
    cdpPort,
    userPayload,
  });

  await spawnWatchdog(rootDir, process.ppid);

  // 5. Launch Browser
  spinner.text = 'Launching browser...';
  if (restoredCapsule) {
    await launchIsolatedBrowser(browserExe, rootDir, targetUrl, cdpPort);
  } else if (initialCookies.length > 0) {
    await launchIsolatedBrowser(browserExe, rootDir, 'about:blank', cdpPort);
    try {
      await injectCookiesViaCDP(cdpPort, initialCookies);
      await navigatePageViaCDP(cdpPort, targetUrl);
    } catch {
      await openSwepBrowser(rootDir, targetUrl, cdpPort);
    }
  } else {
    await launchIsolatedBrowser(browserExe, rootDir, targetUrl, cdpPort);
  }

  spinner.stop();
  const account = userPayload.google_email || handle;
  console.log(chalk.dim('key-id: ') + chalk.cyan(maskKey(inputCode)) + chalk.dim(' (active)'));
  console.log(`Workspace ready for ${account}. Run 'swep checkout' or 'swep exit' when done.`);
}
