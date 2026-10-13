/**
 * Command: chrome / open
 * Mở lại cửa sổ Chrome chứa profile cô lập của Swep
 * Tuyệt đối không ảnh hưởng đến profile Chrome của chủ máy
 */

import chalk from 'chalk';
import fs from 'fs';
import path from 'path';
import { getSwepRoot, openSwepChrome } from '../chrome.js';

export async function chromeCommand(options = {}) {
  const rootDir = getSwepRoot(options.root);
  const profileDir = path.join(rootDir, 'chrome-profile');

  if (!fs.existsSync(profileDir)) {
    console.log(chalk.yellow('ℹ Không tìm thấy phiên làm việc Swep nào đang mở.'));
    console.log(chalk.dim('Hãy chạy lệnh "swep" để mở một phiên làm việc mới trước.\n'));
    return;
  }

  try {
    const opened = await openSwepChrome(rootDir);
    if (opened) {
      console.log(chalk.green.bold('✔ Đã mở lại cửa sổ Chrome chứa profile cô lập của Swep!'));
      console.log(chalk.dim('Profile này độc lập 100% với Chrome cá nhân của chủ máy.\n'));
    } else {
      console.log(chalk.red('Không thể mở Chrome của Swep.'));
    }
  } catch (err) {
    console.log(chalk.red(`Lỗi khi mở Chrome: ${err.message}`));
  }
}
