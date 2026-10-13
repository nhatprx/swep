/**
 * Command: checkout
 * Log out active key, save session capsule to GitHub, clean local browser profile,
 * but preserve Swep core and global command for subsequent key logins.
 */

import fs from 'fs';
import path from 'path';
import ora from 'ora';
import chalk from 'chalk';
import { getSwepRoot, killSwepBrowserProcesses } from '../chrome.js';
import { performCleanup } from '../cleanup.js';
import { readActiveSession, removeActiveSession, maskKey } from '../bridge.js';
import { uploadVaultToGitHub, uploadProfileCapsuleToGitHub } from '../vault.js';
import { aead_encrypt } from '../crypto.js';
import { getCookiesViaCDP, closeChromeViaCDP } from '../cdp.js';
import { packProfileDirectory, encryptCapsule } from '../profile.js';

export async function checkoutCommand(options = {}) {
  const rootDir = getSwepRoot(options.root);
  const activeSession = readActiveSession(rootDir);
  const profileDir = path.join(rootDir, 'chrome-profile');

  if (!activeSession && !fs.existsSync(profileDir)) {
    console.log('No active key session found.');
    console.log("Swep is ready. Run 'swep <code>' to start.\n");
    return;
  }

  const rawKey = activeSession?.loginCode || activeSession?.handle || '';
  const maskedKey = maskKey(rawKey);

  if (maskedKey) {
    console.log(chalk.dim('key-id: ') + chalk.cyan(maskedKey));
  }

  if (options.dryRun) {
    console.log('[dry-run] Simulating session checkout and profile cleaning...');
    return;
  }

  const spinner = ora({
    text: 'Saving session and checking out...',
    color: 'cyan',
    spinner: 'dots',
  }).start();

  // 1. Collect CDP cookies
  let latestCookies = [];
  if (activeSession && activeSession.cdpPort) {
    try {
      const cdpCookies = await getCookiesViaCDP(activeSession.cdpPort);
      if (Array.isArray(cdpCookies) && cdpCookies.length > 0) {
        latestCookies = cdpCookies;
      }
    } catch {
      // ignore
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

  let finalCookies = latestCookies;
  const existingCookies = activeSession?.userPayload?.session?.cookies || [];
  const hasAuthCookies = (list) => Array.isArray(list) && list.some((c) =>
    (c.name === 'SID' || c.name === 'HSID' || c.name === 'SSID' || c.name === '__Secure-1PSID') &&
    (c.domain && c.domain.includes('google'))
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

  // 2. Close browser
  if (activeSession && activeSession.cdpPort) {
    try {
      await closeChromeViaCDP(activeSession.cdpPort);
      await new Promise((r) => setTimeout(r, 1000));
    } catch {
      // ignore
    }
  }
  await killSwepBrowserProcesses(rootDir);
  await new Promise((r) => setTimeout(r, 1000));

  // 3. Save profile capsule to GitHub
  if (activeSession && activeSession.github_pat && fs.existsSync(profileDir)) {
    spinner.text = 'Encrypting and saving session to GitHub...';
    try {
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
    } catch {
      // ignore
    }
  }

  // 4. Perform profile-only cleanup (selfDestruct: false)
  spinner.text = 'Cleaning profile files...';
  try {
    await performCleanup(rootDir, { dryRun: false, selfDestruct: false });
    removeActiveSession(rootDir);
    spinner.stop();
    console.log(chalk.green('Session checked out. Profile cleaned.'));
    console.log("Swep is ready for a new login code.\n");
  } catch (err) {
    spinner.stop();
    console.error(`error: checkout failed (${err.message})`);
  }
}
