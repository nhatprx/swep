/**
 * Command: register
 * Đăng ký lần đầu (cần GitHub Device Flow + Google account riêng cho công việc)
 */

import chalk from 'chalk';
import { printBanner, printBox, prompt, promptSecret, createSpinner } from '../ui.js';
import { startDeviceFlow, pollForToken, getGitHubUser } from '../github.js';
import {
  generateDEK,
  generateCode,
  normalizeCode,
  deriveSeed,
  hkdf,
  aead_encrypt,
  generateRecoveryKey,
  deriveRecoveryKeyBuffer,
  deriveRecoveryAuth,
  getTOTP,
} from '../crypto.js';
import { defaultGate } from '../gate.js';

export async function registerCommand(options) {
  printBanner();
  console.log(chalk.bold.cyan('📝 Bắt đầu quy trình Đăng ký tài khoản Swep mới\n'));

  if (options.dryRun) {
    console.log(chalk.yellow('ℹ Chế độ --dry-run: sẽ mô phỏng mà không gửi yêu cầu lên Gate.\n'));
  }

  // 1. GitHub Device Flow
  let githubToken = 'mock_gh_token';
  let handle = 'testuser';

  if (!options.dryRun) {
    try {
      const spinner = createSpinner('Đang khởi tạo phiên xác thực GitHub Device Flow...');
      const device = await startDeviceFlow();
      spinner.stop();

      console.log(`\n👉 Mở trình duyệt: ${chalk.bold.underline.cyan(device.verification_uri || 'https://github.com/login/device')}`);
      console.log(`🔑 Nhập mã xác nhận: ${chalk.bold.green(device.user_code)}\n`);

      githubToken = await pollForToken(device.device_code, device.interval);
      const user = await getGitHubUser(githubToken);
      handle = user.handle;
      console.log(`${chalk.green('✔')} Xác nhận bạn là: ${chalk.bold.cyan(handle)}\n`);
    } catch (err) {
      console.log(chalk.yellow(`⚠ Không thể hoàn tất GitHub OAuth online: ${err.message}`));
      handle = (await prompt('Nhập GitHub handle của bạn để tiếp tục', 'user')).toLowerCase();
      console.log(chalk.dim(`(Tiếp tục với handle: ${handle})\n`));
    }
  }

  // 2. Thu thập thông tin Google
  console.log(chalk.yellow.bold('⚠ LƯU Ý: Khuyến nghị dùng tài khoản Google RIÊNG cho công việc.'));
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

  const totpSecret = await promptSecret('Khóa 2FA TOTP (chuỗi Base32 khi cài Google Authenticator)');
  if (!totpSecret) {
    console.log(chalk.red('Khóa 2FA không được để trống. Hủy bỏ.'));
    return;
  }

  // Thử tính mã TOTP để kiểm tra tính hợp lệ
  try {
    const testTotp = getTOTP(totpSecret);
    console.log(`${chalk.green('✔')} Đã kiểm tra khóa 2FA: mã hiện thời là [${chalk.bold.yellow(testTotp)}]\n`);
  } catch (err) {
    console.log(chalk.red(`Khóa TOTP Base32 không hợp lệ: ${err.message}`));
    return;
  }

  const spinCrypto = createSpinner('Đang mã hóa gói dữ liệu với Argon2id và AEAD...');

  // 3. Mật mã hóa phía Client
  // DEK (Data Encryption Key)
  const dek = generateDEK();

  // Payload
  const rawPayload = {
    google_email: googleEmail,
    google_password: googlePassword,
    totp_secret: totpSecret,
    version: 1,
  };
  const aadPayload = `${handle}/1`;
  const encryptedPayload = aead_encrypt(dek, rawPayload, aadPayload);

  // Sinh mã 6 ký tự
  const rawCode = generateCode(6);
  const normalizedCode = normalizeCode(rawCode);

  // Dẫn xuất seed và khóa
  const seed = await deriveSeed(normalizedCode, handle);
  const authKey = hkdf(seed, 'swep/auth');
  const codeKey = hkdf(seed, 'swep/wrap');

  // Wrap DEK bằng code_key
  const wrapCode = aead_encrypt(codeKey, { dek: dek.toString('hex') }, `${handle}/code`);

  // Recovery Key
  const recoveryKey = generateRecoveryKey();
  const recoveryKeyBuf = deriveRecoveryKeyBuffer(recoveryKey);
  const wrapRecovery = aead_encrypt(recoveryKeyBuf, { dek: dek.toString('hex') }, `${handle}/recovery`);
  const recoveryAuth = deriveRecoveryAuth(recoveryKey);

  spinCrypto.succeed('Mã hóa dữ liệu hoàn tất!');

  // 4. Gửi lên Gate
  if (!options.dryRun) {
    const spinGate = createSpinner('Đang lưu thông tin an toàn lên Swep Gate...');
    try {
      await defaultGate.register({
        github_token: githubToken,
        handle,
        google_email: googleEmail,
        auth_hash: authKey.toString('hex'),
        wrap_code: wrapCode,
        wrap_recovery: wrapRecovery,
        recovery_auth: recoveryAuth,
        payload: encryptedPayload,
      });
      spinGate.succeed('Đăng ký tài khoản trên Swep Gate thành công!');
    } catch (err) {
      spinGate.warn(chalk.yellow(`Lưu ý kết nối Gate: ${err.message} (Chạy ở chế độ độc lập/local)`));
    }
  }

  // 5. Trình bày mã cho người dùng
  const fullLoginCode = `${handle}-${rawCode}`;
  console.log();
  printBox(
    'Thông tin xác thực của bạn',
    [
      `MÃ ĐĂNG NHẬP:   ${chalk.bold.green(fullLoginCode)}`,
      `KHÓA KHÔI PHỤC: ${chalk.bold.yellow(recoveryKey)}`,
      '',
      chalk.dim('Hãy lưu cả hai ở nơi an toàn. Khóa khôi phục sẽ KHÔNG hiển thị lại!'),
    ],
    'green'
  );
  console.log(chalk.bold.cyan('\nBây giờ bạn có thể dùng lệnh "swep" trên bất kỳ máy tính nào với mã trên!'));
}
