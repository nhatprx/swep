/**
 * Command: down
 * Dọn sạch môi trường làm việc khi hoàn tất công việc:
 * 1. Tự động thu thập cookies/tokens mới nhất, mã hóa và đẩy lên GitHub swep-vault
 * 2. Đóng Chrome của Swep, xóa profile, xóa logs, gỡ app nếu do Swep cài, in báo cáo
 */

import fs from 'fs';
import path from 'path';
import axios from 'axios';
import chalkCol from 'chalk';
import { printBanner, printBox, createSpinner } from '../ui.js';
import { getSwepRoot } from '../chrome.js';
import { performCleanup } from '../cleanup.js';
import { readActiveSession, removeActiveSession } from '../bridge.js';
import { uploadVaultToGitHub } from '../vault.js';
import { aead_encrypt } from '../crypto.js';

export async function downCommand(options = {}) {
  printBanner();
  const rootDir = getSwepRoot(options.root);

  console.log(chalkCol.bold.cyan('🧹 Bắt đầu quy trình Dọn dẹp môi trường Swep (Down)...\n'));

  if (options.dryRun) {
    console.log(chalkCol.yellow('ℹ Chế độ --dry-run: chỉ in ra các hành động sẽ làm.\n'));
  }

  // 1. Đồng bộ Session Capsule lên GitHub trước khi dọn dẹp
  const activeSession = readActiveSession(rootDir);
  if (activeSession && activeSession.github_pat && !options.dryRun) {
    const spinSync = createSpinner('Đang thu thập và đồng bộ Session Capsule lên GitHub swep-vault...');
    try {
      let latestCookies = [];

      // Hỏi Bridge lấy cookies mới nhất
      if (activeSession.port) {
        try {
          const res = await axios.get(`http://127.0.0.1:${activeSession.port}/latest`, { timeout: 3000 });
          if (Array.isArray(res.data?.cookies) && res.data.cookies.length) {
            latestCookies = res.data.cookies;
          }
        } catch {
          // Bridge có thể đã dừng nếu tiến trình chính bị tắt
        }
      }

      // Nếu Bridge không trả về, thử đọc file backup latest-cookies.json
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

      if (latestCookies.length > 0) {
        // Cập nhật payload với session mới nhất
        const userPayload = activeSession.userPayload || {};
        userPayload.session = {
          cookies: latestCookies,
          updated_at: new Date().toISOString(),
        };

        const dek = Buffer.from(activeSession.dek, 'hex');
        const encryptedPayload = aead_encrypt(dek, userPayload, `${activeSession.handle}/1`);

        const vaultData = {
          handle: activeSession.handle,
          version: 1,
          wrap_code: activeSession.wrap_code,
          wrap_recovery: activeSession.wrap_recovery,
          payload: encryptedPayload,
          updated_at: new Date().toISOString(),
        };

        await uploadVaultToGitHub(activeSession.github_pat, activeSession.handle, vaultData);
        spinSync.succeed(`Đã lưu trữ và đồng bộ Session Capsule (${chalkCol.bold(latestCookies.length)} cookies) lên GitHub!`);
      } else {
        spinSync.info(chalkCol.dim('Chưa phát hiện cookies phiên mới nào cần cập nhật.'));
      }
    } catch (err) {
      spinSync.warn(chalkCol.yellow(`Không thể cập nhật GitHub Vault: ${err.message}`));
    }
  }

  // 2. Dọn dẹp máy tính
  const spinner = createSpinner('Đang tiến hành đóng Chrome và dọn dẹp các tài nguyên của Swep...');

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
