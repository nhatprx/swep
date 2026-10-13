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
import {
  saveActiveSession,
  readActiveSession,
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
    if (activeSession && (activeSession.loginCode || activeSession.handle)) {
      const masked = maskKey(activeSession.loginCode || activeSession.handle);
      console.log(chalk.dim('key-id: ') + chalk.cyan(masked) + chalk.dim(' (active)'));
      console.log("Workspace active. Run 'swep open' to view browser, 'swep checkout' to switch key, or 'swep exit' to clean and exit.\n");
      return;
    }

    if (fs.existsSync(existingProfileDir)) {
      const opened = await openSwepBrowser(rootDir, 'https://www.google.com');
      if (opened) {
        console.log("Workspace reopened. Run 'swep checkout' or 'swep exit' when done.");
        return;
      }
    }

    console.error("usage: swep <code>");
    console.error("error: login code is required");
    console.error("Run 'swep register' to create a new workspace vault.\n");
    return;
  }

  // Require login code
  let inputCode = passedCode.trim();

  // If switching to a different key, check out the existing one first
  if (activeSession && activeSession.loginCode && activeSession.loginCode !== inputCode) {
    console.log(chalk.dim('Switching keys. Checking out current key: ') + chalk.cyan(maskKey(activeSession.loginCode)) + chalk.dim('...'));
    await checkoutCommand({ root: options.root });
  }

  const parts = inputCode.split('-');
  if (parts.length < 2) {
    console.error('error: invalid code format (expected: <username>-<code>)');
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
      spinner.stop();
      console.error(`error: authentication failed (${vaultErr.message})`);
      return;
    }
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

  spawnWatchdog(rootDir, process.ppid);

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
