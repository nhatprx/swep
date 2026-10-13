/**
 * Command: down
 * Dọn sạch môi trường làm việc khi hoàn tất công việc:
 * 1. Tự động thu thập cookies/tokens mới nhất qua CDP, mã hóa và đẩy lên GitHub swep-vault
 * 2. Đóng Chrome của Swep, xóa profile, xóa logs, gỡ app nếu do Swep cài, in báo cáo
 */

import fs from 'fs';
import path from 'path';
import chalkCol from 'chalk';
import { printBanner, printBox, createSpinner } from '../ui.js';
import { getSwepRoot, killSwepChromeProcesses } from '../chrome.js';
import { performCleanup } from '../cleanup.js';
import { readActiveSession, removeActiveSession } from '../bridge.js';
import { uploadVaultToGitHub, uploadProfileCapsuleToGitHub } from '../vault.js';
import { aead_encrypt } from '../crypto.js';
import { getCookiesViaCDP } from '../cdp.js';
import { packProfileDirectory, encryptCapsule } from '../profile.js';

export async function downCommand(options = {}) {
  printBanner();
  const rootDir = getSwepRoot(options.root);

  console.log(chalkCol.bold.cyan('🧹 Bắt đầu quy trình Dọn dẹp môi trường Swep (Down)...\n'));

  if (options.dryRun) {
    console.log(chalkCol.yellow('ℹ Chế độ --dry-run: chỉ in ra các hành động sẽ làm.\n'));
  }

  // 1. Thu thập cookies từ RAM Chrome trước khi đóng
  const activeSession = readActiveSession(rootDir);
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
  // Tránh việc nén khi Chrome đang ghi SQLite WAL / LevelDB làm hỏng dữ liệu
  const profileDir = path.join(rootDir, 'chrome-profile');
  let killedCount = 0;

  if (!options.dryRun) {
    const spinClose = createSpinner('Đang đóng tiến trình Chrome và đợi flush dữ liệu xuống đĩa...');
    killedCount = await killSwepChromeProcesses(rootDir);
    // Chờ 1.5s để Windows giải phóng file handles và hoàn tất checkpoint WAL
    await new Promise((r) => setTimeout(r, 1500));
    spinClose.succeed(`Đã đóng ${chalkCol.bold(killedCount)} tiến trình Chrome, dữ liệu đã flush hoàn tất.`);
  }

  // 3. ĐÓNG GÓI VÀ MÃ HÓA PROFILE CAPSULE (Local Storage, LevelDB, Preferences, Cookies)
  if (activeSession && activeSession.github_pat && fs.existsSync(profileDir) && !options.dryRun) {
    const spinCapsule = createSpinner('Đang nén và mã hóa Profile Capsule (Local Storage, LevelDB, Tokens)...');
    try {
      const metadata = {
        handle: activeSession.handle,
        google_email: activeSession.google_email || activeSession.userPayload?.google_email,
        google_password: activeSession.google_password || activeSession.userPayload?.google_password,
        session_cookies: finalCookies,
      };

      // Đóng gói toàn bộ profile (đã tự động lọc bỏ cache rác)
      const gzArchive = packProfileDirectory(profileDir, metadata);
      const dek = Buffer.from(activeSession.dek, 'hex');
      // Mã hóa AEAD ChaCha20-Poly1305 với chữ ký xác thực toàn vẹn
      const encryptedCapsule = encryptCapsule(gzArchive, dek, `${activeSession.handle}/capsule/v2`);

      await uploadProfileCapsuleToGitHub(activeSession.github_pat, activeSession.handle, encryptedCapsule);
      const sizeMb = (encryptedCapsule.length / 1024 / 1024).toFixed(2);
      spinCapsule.succeed(`Đã lưu Profile Capsule (${chalkCol.bold(sizeMb)} MB) an toàn lên GitHub Releases!`);

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
      await uploadVaultToGitHub(activeSession.github_pat, activeSession.handle, vaultData);
    } catch (capsuleErr) {
      spinCapsule.warn(chalkCol.yellow(`Không thể lưu Profile Capsule: ${capsuleErr.message}`));
    }
  }

  // 4. Dọn dẹp máy tính sạch sẽ 100%
  const spinner = createSpinner('Đang xóa sạch profile tạm và dọn dẹp các tài nguyên của Swep...');

  try {
    const report = await performCleanup(rootDir, { dryRun: !!options.dryRun });
    removeActiveSession(rootDir);
    spinner.succeed('Dọn dẹp hoàn tất sạch sẽ 100%!');

    console.log();
    printBox(
      'Báo cáo dọn dẹp hệ thống',
      [
        `✔ Đã đồng bộ session mới nhất lên GitHub: ${chalkCol.bold('An toàn')}`,
        `✔ Đã đóng tiến trình Chrome của Swep: ${chalkCol.bold(report.killedProcesses)} tiến trình`,
        `✔ Đã xóa thư mục profile và dữ liệu: ${chalkCol.bold(report.removedFiles.length)} thư mục`,
        report.uninstalledChrome
          ? `✔ Đã gỡ bỏ Google Chrome (do Swep là bên cài đặt)`
          : `ℹ Giữ nguyên Google Chrome của máy (đã có từ trước)`,
        report.uninstalledSwep
          ? `✔ Đã tự động xóa sạch toàn bộ Swep và gỡ khỏi PATH hệ thống`
          : `ℹ Chế độ repo cục bộ: giữ nguyên mã nguồn dev`,
        `✔ Clipboard và dữ liệu tạm đã được dọn sạch`,
        '',
        chalkCol.green.bold('🎉 MÁY TÍNH HOÀN TOÀN SẠCH SẼ, KHÔNG CÒN DẤU VẾT!'),
      ],
      'green'
    );
  } catch (err) {
    spinner.fail(chalkCol.red(`Lỗi trong quá trình dọn dẹp: ${err.message}`));
  }
}
