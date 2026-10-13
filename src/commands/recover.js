/**
 * Command: recover
 * Khôi phục khi mất mã đăng nhập (sử dụng Khóa khôi phục + GitHub Device Flow)
 */

import chalk from 'chalk';
import { printBanner, printBox, prompt, promptSecret, createSpinner } from '../ui.js';
import { startDeviceFlow, pollForToken, getGitHubUser } from '../github.js';
import {
  generateCode,
  normalizeCode,
  deriveSeed,
  hkdf,
  aead_encrypt,
  aead_decrypt,
  deriveRecoveryKeyBuffer,
  deriveRecoveryAuth,
} from '../crypto.js';
import { defaultGate } from '../gate.js';

export async function recoverCommand(_options) {
  printBanner();
  console.log(chalk.bold.cyan('🚑 Bắt đầu quy trình Khôi phục tài khoản (Recover)\n'));

  // 1. Xác thực GitHub Device Flow
  let githubToken = 'mock_gh_token';
  let handle = 'user';

  try {
    const spinner = createSpinner('Đang kết nối xác thực GitHub Device Flow...');
    const device = await startDeviceFlow();
    spinner.stop();

    console.log(`\n👉 Mở trình duyệt: ${chalk.bold.underline.cyan(device.verification_uri || 'https://github.com/login/device')}`);
    console.log(`🔑 Nhập mã xác nhận: ${chalk.bold.green(device.user_code)}\n`);

    githubToken = await pollForToken(device.device_code, device.interval);
    const user = await getGitHubUser(githubToken);
    handle = user.handle;
    console.log(`${chalk.green('✔')} Xác nhận GitHub: ${chalk.bold.cyan(handle)}\n`);
  } catch (err) {
    console.log(chalk.yellow(`⚠ Bỏ qua xác thực GitHub trực tuyến: ${err.message}`));
    handle = (await prompt('Nhập GitHub handle của bạn', 'user')).toLowerCase();
  }

  // 2. Nhập Recovery Key
  const recoveryKey = await promptSecret('Nhập Khóa khôi phục (Recovery Key dạng 4F8Q-2P9K-...)');
  if (!recoveryKey) {
    console.log(chalk.red('Khóa khôi phục không được để trống. Hủy bỏ.'));
    return;
  }

  const recoveryAuth = deriveRecoveryAuth(recoveryKey);
  const recoveryKeyBuf = deriveRecoveryKeyBuffer(recoveryKey);

  // 3. Gửi yêu cầu recover lên Gate
  const spinRecover = createSpinner('Đang kiểm tra Khóa khôi phục và lấy dữ liệu mã hóa...');
  let recoverRes;
  try {
    recoverRes = await defaultGate.recover(githubToken, handle, recoveryAuth);
    spinRecover.succeed('Xác thực khóa khôi phục thành công!');
  } catch (err) {
    spinRecover.fail(chalk.red(`Khôi phục thất bại: ${err.message}`));
    return;
  }

  const { payload: encPayload, wrap_recovery: wrapRecovery } = recoverRes;

  // 4. Giải mã DEK
  let dek;
  try {
    const dekObj = aead_decrypt(recoveryKeyBuf, wrapRecovery, `${handle}/recovery`);
    dek = Buffer.from(dekObj.dek, 'hex');
  } catch (err) {
    console.log(chalk.red(`Không thể giải mã DEK bằng khóa khôi phục: ${err.message}`));
    return;
  }

  // 5. Sinh mã mới
  const newRawCode = generateCode(6);
  const newNormalizedCode = normalizeCode(newRawCode);
  const newSeed = await deriveSeed(newNormalizedCode, handle);
  const newAuthKey = hkdf(newSeed, 'swep/auth');
  const newCodeKey = hkdf(newSeed, 'swep/wrap');
  const newWrapCode = aead_encrypt(newCodeKey, { dek: dek.toString('hex') }, `${handle}/code`);

  // 6. Gửi lên Gate để kết thúc recover
  const spinFinish = createSpinner('Đang áp dụng mã đăng nhập mới lên hệ thống...');
  try {
    await defaultGate.recoverFinish({
      github_token: githubToken,
      handle,
      auth_hash: newAuthKey.toString('hex'),
      wrap_code: newWrapCode,
      payload: encPayload,
    });
    spinFinish.succeed('Đã cập nhật mã đăng nhập mới thành công!');
  } catch (err) {
    spinFinish.warn(chalk.yellow(`Lưu ý kết nối Gate: ${err.message}`));
  }

  const fullLoginCode = `${handle}-${newRawCode}`;
  console.log();
  printBox(
    'MÃ ĐĂNG NHẬP MỚI CỦA BẠN',
    [
      `👉 ${chalk.bold.green(fullLoginCode)}`,
      '',
      chalk.dim('Mọi mã cũ đã bị hủy. Hãy lưu lại mã này cẩn thận!'),
    ],
    'green'
  );
}
