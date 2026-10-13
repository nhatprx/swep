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
  startLiveSessionDashboard,
} from '../ui.js';
import { registerCommand } from './register.js';
import { downCommand } from './down.js';
import {
  deriveSeed,
  hkdf,
  aead_decrypt,
  normalizeCode,
} from '../crypto.js';
import { fetchVault } from '../vault.js';
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
  getCookiesViaCDP,
} from '../cdp.js';
import {
  takeBeforeSnapshot,
  recordLedger,
} from '../cleanup.js';

export async function loginCommand(options = {}) {
  printBanner();
  const rootDir = getSwepRoot(options.root);

  if (options.dryRun) {
    console.log(chalk.yellow('ℹ Chế độ --dry-run: chỉ in ra quy trình mà không thực thi thay đổi.\n'));
  }

  // 1. Nhập mã đăng nhập
  const inputCode = await prompt('Nhập mã đăng nhập (hoặc gõ "register" nếu chưa có mã)');
  const trimmed = (inputCode || '').trim().toLowerCase();

  if (!trimmed || trimmed === 'register' || trimmed === 'r' || trimmed === 'new') {
    const wantRegister = await promptConfirm('Bạn chưa có mã? Bạn có muốn đăng ký tài khoản Swep mới ngay bây giờ không?', true);
    if (wantRegister) {
      return registerCommand(options);
    }
    console.log(chalk.dim('\nĐể đăng ký mã mới sau, hãy chạy: swep register trên máy tính cá nhân tin cậy của bạn.'));
    return;
  }

  const parts = inputCode.trim().split('-');
  if (parts.length < 2) {
    console.log(chalk.red('Định dạng mã không đúng (cần dạng: username-XXXX-...).'));
    return;
  }

  const handle = parts[0].toLowerCase();
  const rawCode = parts.slice(1).join('-');
  const normalizedCode = normalizeCode(rawCode);

  const spinAuth = createSpinner('Đang dẫn xuất khóa Argon2id và giải mã dữ liệu...');

  let userPayload;
  let dekBuffer;
  let vaultData;

  // 2. Tải vault từ GitHub (Zero-Server Architecture)
  try {
    vaultData = await fetchVault(handle);
    const seed = await deriveSeed(normalizedCode, handle);
    const codeKey = hkdf(seed, 'swep/wrap');

    const dekObj = aead_decrypt(codeKey, vaultData.wrap_code, `${handle}/code`);
    dekBuffer = Buffer.from(dekObj.dek, 'hex');
    userPayload = aead_decrypt(dekBuffer, vaultData.payload, `${handle}/1`);

    const displayAccount = userPayload.google_email || `@${handle}`;
    spinAuth.succeed(`Đã tải và giải mã thành công vault từ GitHub: ${chalk.bold.cyan(displayAccount)}`);
  } catch (vaultErr) {
    // Nếu không tải được từ GitHub Vault, thử fallback sang Swep Gate nếu có
    try {
      const seed = await deriveSeed(normalizedCode, handle);
      const authKey = hkdf(seed, 'swep/auth');
      const codeKey = hkdf(seed, 'swep/wrap');

      const loginRes = await defaultGate.login(handle, authKey.toString('hex'));
      const dekObj = aead_decrypt(codeKey, loginRes.wrap_code, `${handle}/code`);
      dekBuffer = Buffer.from(dekObj.dek, 'hex');
      userPayload = aead_decrypt(dekBuffer, loginRes.payload, `${handle}/1`);

      vaultData = loginRes;
      const displayAccount = userPayload.google_email || `@${handle}`;
      spinAuth.succeed(`Đã đăng nhập thành công qua Swep Gate: ${chalk.bold.cyan(displayAccount)}`);
    } catch {
      spinAuth.fail(chalk.red(`Đăng nhập thất bại: ${vaultErr.message}`));
      return;
    }
  }

  // 3. Kiểm tra Google Chrome trên máy
  let chromeExe = await findChromePath();
  let preexistingChrome = true;

  if (!chromeExe) {
    console.log(chalk.yellow('Chưa tìm thấy Google Chrome. Đang cài đặt qua winget...'));
    const installed = await installChromeViaWinget();
    if (installed) {
      chromeExe = await findChromePath();
      preexistingChrome = false;
    }
  }

  if (!chromeExe) {
    console.log(chalk.red('Không tìm thấy và không thể tự cài Chrome. Vui lòng cài Chrome thủ công.'));
    return;
  }

  // 4. Ghi Snapshot và Ledger
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

  // 5. Chuẩn bị kết nối CDP
  const initialCookies = (userPayload.session && Array.isArray(userPayload.session.cookies))
    ? userPayload.session.cookies
    : [];

  const cdpPort = await getFreePort();
  const targetUrl = initialCookies.length ? 'https://myaccount.google.com' : 'https://accounts.google.com';

  // Lưu trạng thái phiên đang hoạt động vào active-session.json
  saveActiveSession(rootDir, {
    handle,
    google_email: userPayload.google_email || handle,
    github_pat: userPayload.github_pat,
    dek: dekBuffer.toString('hex'),
    wrap_code: vaultData.wrap_code,
    wrap_recovery: vaultData.wrap_recovery,
    cdpPort,
    userPayload,
  });

  // 6. Mở Chrome với Profile cô lập + CDP Port
  console.log(chalk.green('\n✔ Đang mở Chrome với profile tạm thời của Swep...'));
  await launchIsolatedChrome(chromeExe, rootDir, targetUrl, cdpPort);

  if (initialCookies.length > 0) {
    // ĐÃ CÓ PHIÊN: Bơm trực tiếp vào RAM Chrome qua CDP
    const spinCapsule = createSpinner(`Đang bung Session Capsule (${initialCookies.length} cookies) vào Chrome qua CDP...`);
    try {
      await injectCookiesViaCDP(cdpPort, initialCookies);
      spinCapsule.succeed(chalk.bold.green(`✔ Chrome đã tự bung phiên đăng nhập thành công! (Không cần đăng nhập lại)`));
    } catch (err) {
      spinCapsule.warn(chalk.yellow(`Không thể bung cookies qua CDP: ${err.message}`));
    }
  } else {
    // LẦN ĐẦU TIÊN: Hướng dẫn người dùng đăng nhập
    console.log(chalk.bold.yellow('\n📝 LẦN ĐẦU SỬ DỤNG:'));
    console.log(chalk.white('   Hãy đăng nhập tài khoản Google trên cửa sổ Chrome vừa mở.'));
    console.log(chalk.dim('   (Khi bạn xong việc và gõ "swep down", Swep sẽ tự lưu phiên này để từ lần sau KHÔNG CẦN ĐĂNG NHẬP LẠI NỮA!)\n'));
  }

  // 7. Đồng bộ cookies định kỳ mỗi 5 giây qua CDP
  let latestCookiesCache = initialCookies;
  const cookiePollInterval = setInterval(async () => {
    try {
      const c = await getCookiesViaCDP(cdpPort);
      if (Array.isArray(c) && c.length) {
        latestCookiesCache = c;
        fs.writeFileSync(path.join(rootDir, 'latest-cookies.json'), JSON.stringify(c, null, 2), 'utf8');
      }
    } catch {
      // ignore
    }
  }, 5000);

  // 8. Bật Màn hình điều khiển phiên trực tiếp (Live Session Dashboard & 2FA Ticker)
  await startLiveSessionDashboard({
    email: userPayload.google_email || `@${handle}`,
    totpSecret: userPayload.totp_secret || '',
    getLatestCookies: () => latestCookiesCache,
    onOpenChrome: async () => {
      await openSwepChrome(rootDir, targetUrl, cdpPort);
    },
    onDone: async () => {
      clearInterval(cookiePollInterval);
      await downCommand(options);
    },
  });
}
