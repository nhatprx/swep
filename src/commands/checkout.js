/**
 * Command: checkout
 * Log out active key, save session capsule to GitHub, clean local browser profile,
 * but preserve Swep core and global command for subsequent key logins.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import ora from 'ora';
import chalk from 'chalk';
import { getSwepRoot, killSwepBrowserProcesses } from '../chrome.js';
import { performCleanup } from '../cleanup.js';
import { readActiveSession, removeActiveSession, maskKey } from '../bridge.js';
import { uploadVaultToGitHub, uploadProfileCapsuleToGitHub } from '../vault.js';
import {
  aead_encrypt,
  generateCode,
  normalizeCode,
  deriveSeed,
  hkdf,
} from '../crypto.js';
import { getCookiesViaCDP, closeChromeViaCDP } from '../cdp.js';
import { packProfileDirectory, encryptCapsule } from '../profile.js';
import { captureCurrentWorkspaceSnapshot } from '../cortex/observer.js';
import { loadCortexMemory, saveCortexMemory, recordWorkspaceSession } from '../cortex/habit.js';

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

  let nextLoginCode = null;

  // 3. Save profile capsule to GitHub
  if (activeSession && activeSession.github_pat && fs.existsSync(profileDir)) {
    spinner.text = 'Encrypting and saving session to GitHub...';
    try {
      const metadata = {
        handle: activeSession.handle,
        google_email: activeSession.google_email || activeSession.userPayload?.google_email,
        session_cookies: finalCookies,
      };

      // Đóng gói toàn bộ profile (đã tự động lọc bỏ cache rác)
      const gzArchive = await packProfileDirectory(profileDir, metadata);
      // TRUE RE-KEYING: Sinh DEK 256-bit mới toanh cho mỗi phiên làm việc
      const newDek = crypto.randomBytes(32);
      const newDekHex = newDek.toString('hex');
      // Mã hóa AEAD capsule bằng newDek mới
      const encryptedCapsule = encryptCapsule(gzArchive, newDek, `${activeSession.handle}/capsule/v2`);

      // CODE ROTATION: Tự động sinh mã mới, bọc lại newDek và vô hiệu hóa mã cũ
      const newRawCode = generateCode(10);
      const newNormalizedCode = normalizeCode(newRawCode);
      const newSaltBuf = crypto.randomBytes(16);
      const newSeed = await deriveSeed(newNormalizedCode, activeSession.handle, newSaltBuf);
      const newCodeKey = hkdf(newSeed, 'swep/wrap');
      const newWrapCode = aead_encrypt(newCodeKey, { dek: newDekHex }, `${activeSession.handle}/code`);

      const userPayload = activeSession.userPayload || {};
      userPayload.session = {
        cookies: finalCookies,
        capsule_size: encryptedCapsule.length,
        updated_at: new Date().toISOString(),
      };
      if (activeSession.google_email) userPayload.google_email = activeSession.google_email;
      delete userPayload.google_password;

      // Ghi nhận Cortex session memory
      try {
        const snapshot = await captureCurrentWorkspaceSnapshot(process.cwd(), activeSession.cdpPort);
        const cortexData = loadCortexMemory(rootDir, userPayload);
        recordWorkspaceSession(cortexData, snapshot);
        saveCortexMemory(rootDir, cortexData);
        userPayload.cortex = cortexData;
      } catch {
        // ignore cortex recording failures
      }

      // Mã hóa payload mới bằng newDek
      const encryptedPayload = aead_encrypt(newDek, userPayload, `${activeSession.handle}/1`);
      const vaultData = {
        handle: activeSession.handle,
        version: 2,
        salt: newSaltBuf.toString('hex'),
        wrap_code: newWrapCode,
        wrap_recovery: activeSession.wrap_recovery,
        payload: encryptedPayload,
        updated_at: new Date().toISOString(),
      };

      const targetRepo = activeSession.vaultRepo || 'swep-vault';
      try {
        await uploadProfileCapsuleToGitHub(activeSession.github_pat, activeSession.handle, encryptedCapsule, targetRepo);
        await uploadVaultToGitHub(activeSession.github_pat, activeSession.handle, vaultData, targetRepo);

        const cleanGistId = targetRepo.replace(/^gist:/, '');
        const isGist = targetRepo !== 'swep-vault' && !targetRepo.startsWith('swep-vault');
        nextLoginCode = isGist
          ? `${activeSession.handle}-${cleanGistId}-${newRawCode}`
          : `${activeSession.handle}-${newRawCode}`;
      } catch (pushErr) {
        spinner.stop();
        console.error(chalk.red(`\n⚠ Failed to sync session to GitHub: ${pushErr.message}`));
        console.log(chalk.yellow('Your current login code remains valid. Session files were NOT deleted so you can retry "swep checkout".\n'));
        return;
      }
    } catch (err) {
      spinner.stop();
      console.error(chalk.red(`\n⚠ Failed to pack session: ${err.message}`));
      return;
    }
  }

  // 4. Perform profile-only cleanup (selfDestruct: false)
  spinner.text = 'Cleaning profile files...';
  try {
    await performCleanup(rootDir, { dryRun: false, selfDestruct: false });
    removeActiveSession(rootDir);
    spinner.stop();
    console.log(chalk.green('Session checked out. Profile cleaned.'));
    if (nextLoginCode) {
      console.log();
      console.log(chalk.bold.yellow('========================================================================'));
      console.log(chalk.bold.yellow(' [!] MÃ CŨ ĐÃ HẾT HẠN (Lịch sử terminal trên máy này đã vô hại).'));
      console.log(chalk.bold.cyan(' [*] MÃ ĐĂNG NHẬP CHO LẦN TIẾP THEO CỦA BẠN:'));
      console.log(chalk.bold.green(`     swep ${nextLoginCode}`));
      console.log(chalk.bold.yellow('========================================================================'));
      console.log();
    } else {
      console.log("Swep is ready for a new login code.\n");
    }
  } catch (err) {
    spinner.stop();
    console.error(`error: checkout failed (${err.message})`);
  }
}
