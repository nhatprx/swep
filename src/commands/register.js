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

  // 2. Nhận token từ người dùng (Hỗ trợ tự động đọc từ clipboard hoặc dán)
  let cleanToken = '';
  const clipboardText = await getClipboardText();
  if (clipboardText && (clipboardText.startsWith('ghp_') || clipboardText.startsWith('github_pat_'))) {
    console.log(chalk.green(`✔ Đã tự động nhận diện token từ Clipboard: ${chalk.bold(clipboardText.slice(0, 8))}...`));
    const useClip = await promptConfirm('Sử dụng luôn token này?', true);
    if (useClip) {
      cleanToken = clipboardText;
    }
  }

  if (!cleanToken) {
    console.log(chalk.cyan('👉 Mẹo dán trên PowerShell: Bấm Click Chuột Phải hoặc Shift + Insert để dán.'));
    const entered = await prompt('Dán Personal Access Token vào đây');
    cleanToken = (entered || '').trim();
  }

  if (!cleanToken || (!cleanToken.startsWith('ghp_') && !cleanToken.startsWith('github_pat_'))) {
    console.log(chalk.red('Token không đúng định dạng (cần bắt đầu bằng ghp_...). Hủy bỏ.'));
    return;
  }

  // Xác thực token và lấy thông tin người dùng
  const spinUser = createSpinner('Đang xác thực tài khoản GitHub...');
  let handle;
  try {
    const user = await getGitHubUser(cleanToken);
    handle = user.handle;
    spinUser.succeed(`Đã xác thực thành công tài khoản GitHub: @${chalk.bold.cyan(handle)}`);
  } catch (err) {
    spinUser.fail(chalk.red(`Token không hợp lệ hoặc không có quyền: ${err.message}`));
    return;
  }

  // 3. Nhập thông tin tài khoản Google
  console.log();
  console.log(chalk.yellow.bold('⚠ LƯU Ý: Khuyến nghị sử dụng tài khoản Google RIÊNG cho công việc.'));
  const googleEmail = await prompt('Tài khoản Google (email)');
  if (!googleEmail || !googleEmail.includes('@')) {
    console.log(chalk.red('Email không hợp lệ. Hủy bỏ.'));
    return;
  }

  const googlePassword = await promptSecret('Mật khẩu Google');
  if (!googlePassword) {
    console.log(chalk.red('Mật khẩu không được để trống. Hủy bỏ.'));
    return;
  }

  console.log(chalk.dim('\nKhóa 2FA TOTP là chuỗi ký tự bí mật Base32 (khi bấm "Không quét được mã QR?" lúc cài Authenticator).'));
  console.log(chalk.dim('Nếu bạn không có hoặc dùng xác thực khác (SMS/Prompt), hãy nhấn Enter để BỎ QUA.'));
  const totpInput = await promptSecret('Khóa 2FA TOTP (Tùy chọn - Nhấn Enter để bỏ qua)');

  let cleanTotp = (totpInput || '').trim();

  if (/^\d{6}$/.test(cleanTotp)) {
    console.log(chalk.yellow('\n⚠ Bạn vừa nhập mã OTP 6 số tạm thời (mã này đổi sau 30s trên điện thoại, không phải Khóa thiết lập 2FA).'));
    const skip = await promptConfirm('Bạn có muốn bỏ qua bước này và tiếp tục đăng ký không?', true);
    if (skip) {
      cleanTotp = '';
    } else {
      console.log(chalk.dim('Hủy bỏ.'));
      return;
    }
  }

  if (cleanTotp) {
    try {
      const testTotp = getTOTP(cleanTotp);
      console.log(`${chalk.green('✔')} Đã kiểm tra khóa 2FA: mã hiện thời là [${chalk.bold.yellow(testTotp)}]\n`);
    } catch (err) {
      console.log(chalk.yellow(`\n⚠ Khóa 2FA Base32 không hợp lệ (${err.message}).`));
      const skip = await promptConfirm('Bạn có muốn tiếp tục mà không lưu khóa 2FA này không?', true);
      if (skip) {
        cleanTotp = '';
      } else {
        return;
      }
    }
  } else {
    console.log(chalk.dim('✔ Đã bỏ qua khóa 2FA (bạn sẽ xác thực bằng điện thoại khi Google yêu cầu trên Chrome).\n'));
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
