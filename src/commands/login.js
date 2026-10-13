/**
 * Command: login / up (default command)
 * Đăng nhập bằng mã, xoay mã ngay lập tức, mở Chrome với profile riêng
 */

import chalk from 'chalk';
import { printBanner, printBox, prompt, promptConfirm, createSpinner } from '../ui.js';
import { registerCommand } from './register.js';
import {
  deriveSeed,
  hkdf,
  aead_decrypt,
  aead_encrypt,
  generateCode,
  normalizeCode,
  getTOTP,
} from '../crypto.js';
import { defaultGate } from '../gate.js';
import {
  findChromePath,
  installChromeViaWinget,
  launchIsolatedChrome,
  getSwepRoot,
  copyToClipboardWithAutoClear,
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
    console.log(chalk.red('Định dạng mã không đúng (cần dạng: username-XXX-XXX).'));
    return;
  }

  const handle = parts[0].toLowerCase();
  const rawCode = parts.slice(1).join('-');
  const normalizedCode = normalizeCode(rawCode);

  const spinAuth = createSpinner('Đang dẫn xuất khóa Argon2id và kiểm tra danh tính...');

  let authKey, codeKey, seed;
  try {
    seed = await deriveSeed(normalizedCode, handle);
    authKey = hkdf(seed, 'swep/auth');
    codeKey = hkdf(seed, 'swep/wrap');
  } catch (err) {
    spinAuth.fail(chalk.red(`Lỗi dẫn xuất khóa: ${err.message}`));
    return;
  }

  // 2. Gọi Gate /api/login
  let loginRes;
  try {
    loginRes = await defaultGate.login(handle, authKey.toString('hex'));
    spinAuth.succeed('Xác thực danh tính thành công!');
  } catch (err) {
    spinAuth.fail(chalk.red(`Đăng nhập thất bại: ${err.message}`));
    return;
  }

  const { session, payload: encPayload, wrap_code: wrapCode, notices } = loginRes;

  if (notices) {
    console.log(chalk.dim(`ℹ Từ lần đăng nhập trước có ${notices.failed_count || 0} lần nhập sai mã.`));
  }

  // 3. Giải mã DEK và Payload
  const spinDecrypt = createSpinner('Đang giải mã gói thông tin tài khoản...');
  let dek, userPayload;
  try {
    const dekObj = aead_decrypt(codeKey, wrapCode, `${handle}/code`);
    dek = Buffer.from(dekObj.dek, 'hex');
    userPayload = aead_decrypt(dek, encPayload, `${handle}/1`);
    spinDecrypt.succeed(`Đã giải mã thành công thông tin tài khoản: ${chalk.bold.cyan(userPayload.google_email)}`);
  } catch (err) {
    spinDecrypt.fail(chalk.red(`Không thể giải mã dữ liệu (mã sai hoặc hỏng): ${err.message}`));
    return;
  }

  // 4. Xoay mã ngay lập tức (Code Rotation)
  console.log();
  const newRawCode = generateCode(6);
  const newNormalizedCode = normalizeCode(newRawCode);
  const fullNewCode = `${handle}-${newRawCode}`;

  const spinRotate = createSpinner('Đang chuẩn bị mã mới an toàn...');
  try {
    const newSeed = await deriveSeed(newNormalizedCode, handle);
    const newAuthKey = hkdf(newSeed, 'swep/auth');
    const newCodeKey = hkdf(newSeed, 'swep/wrap');
    const newWrapCode = aead_encrypt(newCodeKey, { dek: dek.toString('hex') }, `${handle}/code`);

    await defaultGate.rotateStage(session, newAuthKey.toString('hex'), newWrapCode);
    spinRotate.succeed('Mã mới đã được tạo và lưu ở trạng thái chờ.');
  } catch (err) {
    spinRotate.warn(chalk.yellow(`Lưu ý xoay mã: ${err.message}`));
  }

  printBox(
    'Mã MỚI của bạn cho lần đăng nhập sau',
    [
      `👉 ${chalk.bold.green(fullNewCode)}   ← ${chalk.bold('LƯU LẠI NGAY')}`,
      chalk.dim('Mã cũ sẽ hết hiệu lực sau khi bạn xác nhận bên dưới.'),
    ],
    'yellow'
  );

  // Yêu cầu nhập lại để xác nhận đã lưu
  let confirmed = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    const confirmInput = await prompt('Nhập lại mã mới để xác nhận đã lưu');
    const confirmNormalized = normalizeCode(confirmInput.replace(`${handle}-`, ''));
    if (confirmNormalized === newNormalizedCode) {
      confirmed = true;
      break;
    }
    console.log(chalk.red('Mã nhập lại chưa khớp, vui lòng kiểm tra kỹ!'));
  }

  if (confirmed) {
    try {
      await defaultGate.rotateConfirm(session);
      console.log(chalk.green('✔ Đã đổi mã thành công. Mã cũ chính thức hết hiệu lực.\n'));
    } catch (err) {
      console.log(chalk.yellow(`⚠ Xác nhận xoay mã: ${err.message}\n`));
    }
  } else {
    console.log(chalk.red('⚠ Chưa xác nhận mã mới. Mã cũ vẫn còn hiệu lực để bạn không bị khóa.\n'));
  }

  // 5. Kiểm tra Chrome
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

  // 6. Ghi Snapshot và Ledger
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

  // 7. Tính TOTP và hỗ trợ đăng nhập
  let currentTotp = '';
  try {
    currentTotp = getTOTP(userPayload.totp_secret);
  } catch {
    // ignore
  }

  console.log(chalk.cyan.bold('🔐 THÔNG TIN ĐĂNG NHẬP GOOGLE:'));
  console.log(`   Email:    ${chalk.bold(userPayload.google_email)}`);
  console.log(`   Mật khẩu: ${chalk.bold('********')} ${chalk.dim('(Đã sẵn sàng)')}`);
  if (currentTotp) {
    console.log(`   Mã 2FA:   ${chalk.bold.yellow(currentTotp)} ${chalk.dim('(Tự đổi sau 30s)')}`);
  }

  // Tự động copy mật khẩu vào clipboard có auto-clear
  if (userPayload.google_password) {
    await copyToClipboardWithAutoClear(userPayload.google_password, 30);
    console.log(chalk.dim('   (Mật khẩu đã được copy vào clipboard, tự xóa sau 30 giây)'));
  }

  // 8. Khởi chạy Chrome với profile riêng biệt
  console.log(chalk.green('\n✔ Đang mở Chrome với profile tạm thời của Swep...'));
  await launchIsolatedChrome(chromeExe, rootDir, 'https://accounts.google.com');

  console.log(chalk.green.bold('✔ Sẵn sàng làm việc!'));
  console.log(chalk.dim('\nKhi hoàn thành công việc, hãy mở terminal và chạy:'));
  console.log(chalk.bold.cyan('  swep down\n'));
}
