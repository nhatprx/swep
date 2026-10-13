/**
 * Command: down
 * Dọn sạch môi trường làm việc khi hoàn tất công việc:
 * Đóng Chrome của Swep, xóa profile, xóa logs, gỡ app nếu do Swep cài, in báo cáo
 */

import chalk from 'chalk';
import { printBanner, printBox, createSpinner } from '../ui.js';
import { getSwepRoot } from '../chrome.js';
import { performCleanup } from '../cleanup.js';

export async function downCommand(options) {
  printBanner();
  const rootDir = getSwepRoot(options.root);

  console.log(chalk.bold.cyan('🧹 Bắt đầu quy trình Dọn dẹp môi trường Swep (Down)...\n'));

  if (options.dryRun) {
    console.log(chalk.yellow('ℹ Chế độ --dry-run: chỉ in ra các hành động sẽ làm.\n'));
  }

  const spinner = createSpinner('Đang tiến hành dọn dẹp các tài nguyên của Swep...');

  try {
    const report = await performCleanup(rootDir, { dryRun: !!options.dryRun });
    spinner.succeed('Dọn dẹp hoàn tất!');

    console.log();
    printBox(
      'Báo cáo dọn dẹp hệ thống',
      [
        `✔ Đã đóng tiến trình Chrome của Swep: ${chalk.bold(report.killedProcesses)} tiến trình`,
        `✔ Đã xóa thư mục profile và dữ liệu: ${chalk.bold(report.removedFiles.length)} thư mục`,
        report.uninstalledChrome
          ? `✔ Đã gỡ bỏ Google Chrome (do Swep là bên cài đặt)`
          : `ℹ Giữ nguyên Google Chrome của máy (đã có từ trước)`,
        `✔ Clipboard đã được dọn sạch`,
        '',
        chalk.yellow.bold('⚠ VIỆC CẦN LÀM THỦ CÔNG:'),
        chalk.yellow('Vào ') + chalk.bold.underline.cyan('https://myaccount.google.com/device-activity') + chalk.yellow(' và đăng xuất thiết bị này!'),
      ],
      'green'
    );
  } catch (err) {
    spinner.fail(chalk.red(`Lỗi trong quá trình dọn dẹp: ${err.message}`));
  }
}
