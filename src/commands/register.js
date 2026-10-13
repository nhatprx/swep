/**
 * Command: register (Zero-Server GitHub Architecture)
 * Đăng ký tài khoản: Mở Chromium hoàn toàn mới để đăng nhập GitHub,
 * tạo kho lưu trữ swep-vault và lưu gói dữ liệu đã mã hóa lên GitHub của bạn
 */

import chalk from 'chalk';
import { printBanner, printBox, prompt, promptSecret, promptConfirm, createSpinner } from '../ui.js';
import { openCleanBrowserForGitHub, getClipboardText } from '../chrome.js';
import { getGitHubUser } from '../github.js';
import { ensureVaultRepo, uploadVaultToGitHub } from '../vault.js';
import {
  generateDEK,
  generateCode,
  normalizeCode,
  deriveSeed,
  hkdf,
  aead_encrypt,
  generateRecoveryKey,
  deriveRecoveryKeyBuffer,
  getTOTP,
} from '../crypto.js';

export async function registerCommand(options) {
  printBanner();
  console.log(chalk.bold.cyan('📝 Bắt đầu quy trình Đăng ký Swep Vault (Zero-Server)\n'));

  // 1. Mở Chromium độc lập để người dùng đăng nhập GitHub
  console.log(chalk.cyan('👉 Swep đang mở một cửa sổ Chrome mới (profile cô lập) để bạn đăng nhập GitHub...'));
  console.log(chalk.dim('   (Trang web sẽ tự mở đến trang cấp quyền Personal Access Token cho repo swep-vault)\n'));

  const tokenUrl = 'https://github.com/settings/tokens/new?description=Swep+Vault+Access&scopes=public_repo';

  try {
    await openCleanBrowserForGitHub(tokenUrl);
    console.log(chalk.green('✔ Đã mở trình duyệt! Hãy thực hiện các bước sau trên trình duyệt vừa mở:'));
    console.log(`   1. Đăng nhập vào tài khoản GitHub của bạn.`);
    console.log(`   2. Cuộn xuống cuối trang và bấm ${chalk.bold.green('"Generate token"')}.`);
    console.log(`   3. Copy chuỗi token tạo được (${chalk.dim('bắt đầu bằng ghp_...')}).\n`);
  } catch (err) {
    console.log(chalk.yellow(`⚠ Không thể tự động mở Chrome: ${err.message}`));
    console.log(`👉 Vui lòng mở thủ công link: ${chalk.underline.cyan(tokenUrl)}\n`);
  }

  // 2. Nhận token từ người dùng (Vòng lặp thử lại cho đến khi hợp lệ)
  let cleanToken = '';
  let handle = '';

  while (true) {
    // Thử đọc từ clipboard trước
    const clipboardText = await getClipboardText();
    if (clipboardText && (clipboardText.startsWith('ghp_') || clipboardText.startsWith('github_pat_'))) {
      console.log(chalk.green(`✔ Phát hiện token trong Clipboard: ${chalk.bold(clipboardText.slice(0, 8))}...`));
      const useClip = await promptConfirm('Sử dụng token này?', true);
      if (useClip) {
        cleanToken = clipboardText;
      }
    }

    if (!cleanToken) {
      console.log(chalk.cyan('👉 Mẹo dán: Click Chuột Phải vào màn hình terminal để dán (hoặc gõ "exit" để hủy).'));
      const entered = await prompt('Dán Personal Access Token vào đây');
      if (entered.trim().toLowerCase() === 'exit' || entered.trim().toLowerCase() === 'q') {
        console.log(chalk.dim('Đã hủy bỏ quy trình đăng ký.'));
        return;
      }
      cleanToken = entered.trim();
    }

    if (!cleanToken || (!cleanToken.startsWith('ghp_') && !cleanToken.startsWith('github_pat_'))) {
      console.log(chalk.yellow('⚠ Token không đúng định dạng (cần bắt đầu bằng ghp_... hoặc github_pat_...). Vui lòng thử lại!\n'));
      cleanToken = '';
      continue;
    }

    // Kiểm tra token với GitHub API
    const spinUser = createSpinner('Đang xác thực token với GitHub...');
    try {
      const user = await getGitHubUser(cleanToken);
      handle = user.handle;
      spinUser.succeed(`Đã xác thực thành công tài khoản GitHub: @${chalk.bold.cyan(handle)}`);
      break; // Hợp lệ -> Thoát vòng lặp
    } catch (err) {
      spinUser.fail(chalk.red(`Token không hợp lệ hoặc thiếu quyền: ${err.message}`));
      console.log(chalk.yellow('Vui lòng kiểm tra lại token và thử lại.\n'));
      cleanToken = '';
    }
  }

  // 3. Nhập thông tin tài khoản Google (Có vòng lặp kiểm tra)
  console.log();
  console.log(chalk.yellow.bold('⚠ LƯU Ý: Khuyến nghị sử dụng tài khoản Google RIÊNG cho công việc.'));

  let googleEmail = '';
  while (true) {
    googleEmail = (await prompt('Tài khoản Google (email)')).trim();
    if (googleEmail.toLowerCase() === 'exit' || googleEmail.toLowerCase() === 'q') return;
    if (googleEmail && googleEmail.includes('@') && googleEmail.includes('.')) {
      break;
    }
    console.log(chalk.yellow('⚠ Email không hợp lệ (cần có @ và tên miền, ví dụ user@gmail.com). Vui lòng nhập lại:'));
  }

  let googlePassword = '';
  while (true) {
    googlePassword = await promptSecret('Mật khẩu Google');
    if (googlePassword) break;
    console.log(chalk.yellow('⚠ Mật khẩu không được để trống. Vui lòng nhập lại:'));
  }

  // Khóa 2FA TOTP (Tùy chọn - có vòng lặp hướng dẫn)
  console.log(chalk.cyan.bold('\n🔐 Khóa 2FA TOTP (để Swep tự sinh mã 6 số và đăng nhập 100% không cần điện thoại):'));
  console.log(chalk.dim('   • Lấy tại: myaccount.google.com/security -> Xác minh 2 bước -> Authenticator -> "Không thể quét mã?"'));
  console.log(chalk.dim('   • Là chuỗi chữ cái Base32 bí mật (16-32 ký tự, không chứa số 0, 1, 8, 9).'));
  console.log(chalk.dim('   • Hoặc nhấn Enter để BỎ QUA (nếu bạn muốn xác nhận bằng điện thoại khi mở Chrome).\n'));

  let cleanTotp = '';
  while (true) {
    const totpInput = await promptSecret('Khóa 2FA TOTP (Nhấn Enter để bỏ qua)');
    cleanTotp = (totpInput || '').trim();

    if (!cleanTotp) {
      console.log(chalk.dim('✔ Đã bỏ qua khóa 2FA (bạn sẽ xác thực bằng điện thoại khi Google hỏi trên Chrome).\n'));
      break;
    }

    if (/^\d{6}$/.test(cleanTotp)) {
      console.log(chalk.yellow('\n⚠ Bạn vừa nhập mã OTP 6 số tạm thời (đổi mỗi 30s trên app, không phải Khóa thiết lập Base32 dài).'));
      const retry = await promptConfirm('Bạn có muốn thử nhập lại khóa 2FA dài không? [y = nhập lại, n = bỏ qua]', false);
      if (retry) {
        continue;
      } else {
        cleanTotp = '';
        break;
      }
    }

    // Kiểm tra tính hợp lệ của chuỗi Base32
    try {
      const testTotp = getTOTP(cleanTotp);
      console.log(`${chalk.green('✔')} Khóa 2FA hợp lệ! Mã thử nghiệm hiện tại: [${chalk.bold.yellow(testTotp)}]\n`);
      break;
    } catch (err) {
      console.log(chalk.yellow(`\n⚠ Khóa 2FA Base32 không hợp lệ (${err.message}).`));
      const retry = await promptConfirm('Bạn có muốn thử nhập lại khóa 2FA không? [y = thử lại, n = bỏ qua]', true);
      if (!retry) {
        cleanTotp = '';
        break;
      }
    }
  }

  // 4. Mật mã hóa phía Client (Argon2id + ChaCha20-Poly1305)
  const spinCrypto = createSpinner('Đang mã hóa dữ liệu với Argon2id và AEAD...');

  const dek = generateDEK();
  const rawPayload = {
    google_email: googleEmail,
    google_password: googlePassword,
    totp_secret: cleanTotp,
    version: 1,
  };
  const aadPayload = `${handle}/1`;
  const encryptedPayload = aead_encrypt(dek, rawPayload, aadPayload);

  // Sinh mã an toàn 10 ký tự Crockford Base32 (~50 bit entropy)
  const rawCode = generateCode(10);
  const normalizedCode = normalizeCode(rawCode);

  const seed = await deriveSeed(normalizedCode, handle);
  const codeKey = hkdf(seed, 'swep/wrap');
  const wrapCode = aead_encrypt(codeKey, { dek: dek.toString('hex') }, `${handle}/code`);

  // Recovery Key 128 bit
  const recoveryKey = generateRecoveryKey();
  const recoveryKeyBuf = deriveRecoveryKeyBuffer(recoveryKey);
  const wrapRecovery = aead_encrypt(recoveryKeyBuf, { dek: dek.toString('hex') }, `${handle}/recovery`);

  spinCrypto.succeed('Mã hóa dữ liệu an toàn hoàn tất!');

  // Gói vault lưu trữ trên GitHub
  const vaultData = {
    handle,
    version: 1,
    wrap_code: wrapCode,
    wrap_recovery: wrapRecovery,
    payload: encryptedPayload,
    updated_at: new Date().toISOString(),
  };

  // 5. Tạo repository swep-vault và tải file lên GitHub của user
  if (!options.dryRun) {
    const spinRepo = createSpinner(`Đang khởi tạo repository 'swep-vault' trên GitHub của @${handle}...`);
    try {
      await ensureVaultRepo(cleanToken);
      spinRepo.succeed(`Repository 'swep-vault' đã sẵn sàng trên GitHub!`);
    } catch (err) {
      spinRepo.fail(chalk.red(`Không thể tạo repo: ${err.message}`));
      return;
    }

    const spinUpload = createSpinner('Đang commit file vault.json đã mã hóa lên GitHub...');
    try {
      await uploadVaultToGitHub(cleanToken, handle, vaultData);
      spinUpload.succeed('Đã lưu trữ dữ liệu an toàn vào GitHub của bạn!');
    } catch (err) {
      spinUpload.fail(chalk.red(`Lỗi upload: ${err.message}`));
      return;
    }
  }

  // 6. Hiển thị thông tin hoàn tất
  const fullLoginCode = `${handle}-${rawCode}`;
  console.log();
  printBox(
    'Thông tin xác thực Swep của bạn',
    [
      `MÃ ĐĂNG NHẬP:   ${chalk.bold.green(fullLoginCode)}`,
      `KHÓA KHÔI PHỤC: ${chalk.bold.yellow(recoveryKey)}`,
      `KHO LƯU TRỮ:    ${chalk.dim(`https://github.com/${handle}/swep-vault`)}`,
      '',
      chalk.dim('Lưu lại mã này ở nơi an toàn. Khóa khôi phục sẽ KHÔNG hiển thị lại!'),
    ],
    'green'
  );

  console.log(chalk.bold.cyan('\n🎉 Hoàn tất! Từ nay trên bất kỳ máy mượn nào, bạn chỉ cần gõ "swep" và nhập mã trên!'));
}
