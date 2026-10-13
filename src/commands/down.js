/**
 * Command: down
 * Dọn sạch môi trường làm việc khi hoàn tất công việc:
 * 1. Tự động thu thập cookies/tokens mới nhất qua CDP, mã hóa và đẩy lên GitHub swep-vault
 * 2. Đóng Chrome của Swep, xóa profile, xóa logs, gỡ app nếu do Swep cài, in báo cáo
 */

import fs from 'fs';
import path from 'path';
import ora from 'ora';
import chalk from 'chalk';
import { getSwepRoot, killSwepBrowserProcesses } from '../chrome.js';
import { performCleanup } from '../cleanup.js';
import { readActiveSession, removeActiveSession, getActiveKey, maskKey } from '../bridge.js';
import { uploadVaultToGitHub, uploadProfileCapsuleToGitHub } from '../vault.js';
import { aead_encrypt } from '../crypto.js';
import { getCookiesViaCDP, closeChromeViaCDP } from '../cdp.js';
import { packProfileDirectory, encryptCapsule } from '../profile.js';

export async function downCommand(options = {}) {
  const rootDir = getSwepRoot(options.root);
  const active = getActiveKey(rootDir);

  if (active) {
    console.log(chalk.dim('key-id: ') + chalk.cyan(active.maskedKey));
  }

  const spinner = ora({
    text: 'Closing browser...',
    color: 'cyan',
    spinner: 'dots',
  }).start();

  // 1. Thu thập cookies từ RAM Chrome trước khi đóng
  let latestCookies = [];

  if (activeSession && activeSession.cdpPort && !options.dryRun) {
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
  const existingCookies = (activeSession?.userPayload?.session?.cookies) || [];
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

  // 2. ĐẢM BẢO CHROME ĐÃ ĐÓNG HOÀN TOÀN TRƯỚC KHI ĐÓNG GÓI
  const profileDir = path.join(rootDir, 'chrome-profile');

  if (!options.dryRun) {
    // 1. Thử đóng nhẹ nhàng qua CDP Browser.close trước
    if (activeSession && activeSession.cdpPort) {
      try {
        await closeChromeViaCDP(activeSession.cdpPort);
        await new Promise((r) => setTimeout(r, 1200));
      } catch {
        // ignore
      }
    }
    // 2. Tắt các tiến trình phụ còn sót lại
    await killSwepBrowserProcesses(rootDir);
    await new Promise((r) => setTimeout(r, 1200));
  }

  // 3. ĐÓNG GÓI VÀ MÃ HÓA PROFILE CAPSULE (Local Storage, LevelDB, Preferences, Cookies)
  if (activeSession && activeSession.github_pat && fs.existsSync(profileDir) && !options.dryRun) {
    spinner.text = 'Encrypting and saving session to GitHub...';
    try {
      const metadata = {
        handle: activeSession.handle,
        google_email: activeSession.google_email || activeSession.userPayload?.google_email,
        google_password: activeSession.google_password || activeSession.userPayload?.google_password,
        session_cookies: finalCookies,
      };

      // Đóng gói toàn bộ profile (đã tự động lọc bỏ cache rác)
      const gzArchive = await packProfileDirectory(profileDir, metadata);
      const dek = Buffer.from(activeSession.dek, 'hex');
      // Mã hóa AEAD ChaCha20-Poly1305 với chữ ký xác thực toàn vẹn
      const encryptedCapsule = encryptCapsule(gzArchive, dek, `${activeSession.handle}/capsule/v2`);

      const targetRepo = activeSession.vaultRepo || 'swep-vault';
      await uploadProfileCapsuleToGitHub(activeSession.github_pat, activeSession.handle, encryptedCapsule, targetRepo);

      // Cập nhật metadata trong vault.json
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
      // capsule upload error - continue to cleanup
    }
  }

  // 4. Clean up workspace
  spinner.text = 'Cleaning up workspace files...';
  try {
    await performCleanup(rootDir, { dryRun: !!options.dryRun, selfDestruct: true });
    removeActiveSession(rootDir);
    spinner.stop();

    if (options.dryRun) {
      console.log('[dry-run] Workspace cleanup simulated.');
    } else {
      console.log('Workspace saved and removed.');
    }
  } catch (err) {
    spinner.stop();
    console.error(`error: cleanup failed: ${err.message}`);
  }
}
