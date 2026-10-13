/**
 * Command: login / up (default command)
 * Đăng nhập bằng mã: Tải vault từ GitHub của user (Zero-Server) hoặc Swep Gate,
 * giải mã và mở Chrome với profile riêng
 */

import chalk from 'chalk';
import { printBanner, prompt, promptConfirm, createSpinner } from '../ui.js';
import { registerCommand } from './register.js';
import {
  deriveSeed,
  hkdf,
  aead_decrypt,
  normalizeCode,
  getTOTP,
} from '../crypto.js';
import { fetchVault } from '../vault.js';
import { defaultGate } from '../gate.js';
import {
  findChromePath,
  installChromeViaWinget,
  launchIsolatedChrome,
  getSwepRoot,
  copyToClipboardWithAutoClear,
  autoFillGoogleLogin,
} from '../chrome.js';
import {
  takeBeforeSnapshot,
  recordLedger,
} from '../cleanup.js';

export async function loginCommand(options) {
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

  // 2. Tải vault từ GitHub (Zero-Server Architecture)
  try {
    const vault = await fetchVault(handle);
    const seed = await deriveSeed(normalizedCode, handle);
    const codeKey = hkdf(seed, 'swep/wrap');

    const dekObj = aead_decrypt(codeKey, vault.wrap_code, `${handle}/code`);
    const dek = Buffer.from(dekObj.dek, 'hex');
    userPayload = aead_decrypt(dek, vault.payload, `${handle}/1`);

    spinAuth.succeed(`Đã tải và giải mã thành công vault từ GitHub: ${chalk.bold.cyan(userPayload.google_email)}`);
  } catch (vaultErr) {
    // Nếu không tải được từ GitHub Vault, thử fallback sang Swep Gate nếu có
    try {
      const seed = await deriveSeed(normalizedCode, handle);
      const authKey = hkdf(seed, 'swep/auth');
      const codeKey = hkdf(seed, 'swep/wrap');

      const loginRes = await defaultGate.login(handle, authKey.toString('hex'));
      const dekObj = aead_decrypt(codeKey, loginRes.wrap_code, `${handle}/code`);
      const dek = Buffer.from(dekObj.dek, 'hex');
      userPayload = aead_decrypt(dek, loginRes.payload, `${handle}/1`);

      spinAuth.succeed(`Đã đăng nhập thành công qua Swep Gate: ${chalk.bold.cyan(userPayload.google_email)}`);
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
    email: userPayload.google_email,
    chromeExe,
  });

  recordLedger(rootDir, {
    action: preexistingChrome ? 'use_chrome' : 'install_chrome',
    preexisting: preexistingChrome,
    chromeExe,
  });

  // 5. Tính TOTP và hỗ trợ đăng nhập
  let currentTotp = '';
  try {
    currentTotp = getTOTP(userPayload.totp_secret);
  } catch {
    // ignore
  }

  console.log();
  console.log(chalk.cyan.bold('🔐 THÔNG TIN ĐĂNG NHẬP GOOGLE:'));
  console.log(`   Email:    ${chalk.bold(userPayload.google_email)}`);
  console.log(`   Mật khẩu: ${chalk.bold('********')} ${chalk.dim('(Đã sẵn sàng)')}`);
  if (currentTotp) {
    console.log(`   Mã 2FA:   ${chalk.bold.yellow(currentTotp)} ${chalk.dim('(Tự đổi sau 30s)')}`);
  }

  // 6. Khởi chạy Chrome với profile riêng biệt
  console.log(chalk.green('\n✔ Đang mở Chrome với profile tạm thời của Swep...'));
  await launchIsolatedChrome(chromeExe, rootDir, 'https://accounts.google.com');

  const spinAuto = createSpinner('⚡ Đang tự động điền Email & Mật khẩu vào Chrome (vui lòng không bấm chuột ra ngoài)...');
  const filled = await autoFillGoogleLogin(userPayload.google_email, userPayload.google_password, currentTotp);
  if (filled) {
    spinAuto.succeed(chalk.green('Đã tự động gửi thông tin đăng nhập Google thành công!'));
  } else {
    spinAuto.info(chalk.yellow('Không thể tự động điền (Mật khẩu đã được copy vào Clipboard để bạn tự dán).'));
    if (userPayload.google_password) {
      await copyToClipboardWithAutoClear(userPayload.google_password, 30);
    }
  }

  console.log(chalk.green.bold('\n✔ Sẵn sàng làm việc!'));
  console.log(chalk.dim('Khi hoàn thành công việc, hãy mở terminal và chạy:'));
  console.log(chalk.bold.cyan('  swep down\n'));
}
