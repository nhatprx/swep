/**
 * Command: chrome / open
 * Mở lại cửa sổ Chrome chứa profile cô lập của Swep
 * Tuyệt đối không ảnh hưởng đến profile Chrome của chủ máy
 */

import chalk from 'chalk';
import fs from 'fs';
import path from 'path';
import { getSwepRoot, openSwepChrome } from '../chrome.js';
import { readActiveSession } from '../bridge.js';

export async function chromeCommand(options = {}) {
  const rootDir = getSwepRoot(options.root);
  const profileDir = path.join(rootDir, 'chrome-profile');

  if (!fs.existsSync(profileDir)) {
    console.log(chalk.red('\n✖ Chưa tìm thấy key hay phiên làm việc nào trên máy.'));
    console.log(chalk.white('Vui lòng mở bằng: ') + chalk.bold.cyan('swep <mã>') + chalk.white(' (hoặc đăng ký: ') + chalk.bold.cyan('swep register') + chalk.white(')\n'));
    return;
  }

  const activeSession = readActiveSession(rootDir);
  const cdpPort = activeSession?.cdpPort || 0;

  try {
    const opened = await openSwepChrome(rootDir, 'https://www.google.com', cdpPort);
    if (opened) {
      console.log(chalk.green.bold('✔ Đã mở cửa sổ Chrome của Swep!'));
    } else {
      console.log(chalk.red('Không thể mở Chrome của Swep.'));
    }
  } catch (err) {
    console.log(chalk.red(`Lỗi khi mở Chrome: ${err.message}`));
  }
}
