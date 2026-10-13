/**
 * Command: revoke
 * Kill switch: vô hiệu hóa toàn bộ mã hiện tại, bắt buộc khôi phục mới dùng lại được
 */

import chalk from 'chalk';
import { printBanner, printBox, promptConfirm, createSpinner } from '../ui.js';
import { startDeviceFlow, pollForToken, getGitHubUser } from '../github.js';
import { defaultGate } from '../gate.js';

export async function revokeCommand(_options) {
  printBanner();
  console.log(chalk.bold.red('🚨 Bắt đầu quy trình Thu hồi khẩn cấp (Kill Switch - Revoke)\n'));

  console.log(chalk.yellow('Cảnh báo: Hành động này sẽ lập tức hủy bỏ mọi mã đăng nhập đang hoạt động.'));
  console.log(chalk.yellow('Bạn sẽ phải sử dụng Khóa khôi phục (Recovery Key) qua lệnh `swep recover` để dùng lại.\n'));

  const confirm = await promptConfirm('Bạn có chắc chắn muốn vô hiệu hóa tài khoản ngay bây giờ?', false);
  if (!confirm) {
    console.log(chalk.dim('Đã hủy bỏ thao tác revoke.'));
    return;
  }

  // 1. Xác thực GitHub Device Flow
  let githubToken = 'mock_gh_token';

  try {
    const spinner = createSpinner('Đang kết nối xác thực GitHub Device Flow...');
    const device = await startDeviceFlow();
    spinner.stop();

    console.log(`\n👉 Mở trình duyệt: ${chalk.bold.underline.cyan(device.verification_uri || 'https://github.com/login/device')}`);
    console.log(`🔑 Nhập mã xác nhận: ${chalk.bold.green(device.user_code)}\n`);

    githubToken = await pollForToken(device.device_code, device.interval);
    const user = await getGitHubUser(githubToken);
    console.log(`${chalk.green('✔')} Xác nhận GitHub: ${chalk.bold.cyan(user.handle)}\n`);
  } catch (err) {
    console.log(chalk.yellow(`⚠ Bỏ qua xác thực GitHub trực tuyến: ${err.message}`));
  }

  // 2. Gửi yêu cầu revoke lên Gate
  const spinRevoke = createSpinner('Đang gửi lệnh thu hồi mã đến Swep Gate...');
  try {
    await defaultGate.revoke(githubToken);
    spinRevoke.succeed('Đã thu hồi thành công!');
  } catch (err) {
    spinRevoke.fail(chalk.red(`Lỗi thu hồi: ${err.message}`));
    return;
  }

  console.log();
  printBox(
    'TÀI KHOẢN ĐÃ BỊ VÔ HIỆU HÓA (REVOKED)',
    [
      '✔ Mọi mã đăng nhập cũ đã bị hủy ngay lập tức.',
      '✔ Kẻ lạ không thể đăng nhập kể cả khi biết mã cũ.',
      '',
      chalk.cyan('Để sử dụng lại, hãy chạy lệnh:') + chalk.bold.green(' swep recover'),
    ],
    'red'
  );
}
