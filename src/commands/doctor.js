/**
 * Command: doctor
 * Kiểm tra điều kiện máy, môi trường, công cụ cần thiết (không thay đổi gì)
 */

import os from 'os';
import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import chalk from 'chalk';
import { printBanner } from '../ui.js';
import { findChromePath, getSwepRoot } from '../chrome.js';
import { defaultGate } from '../gate.js';

const execAsync = promisify(exec);

export async function doctorCommand(options) {
  printBanner();
  console.log(chalk.bold.cyan('🔍 Bắt đầu kiểm tra điều kiện hệ thống (Doctor)... \n'));

  const checks = [];

  // 1. Hệ điều hành
  const isWindows = process.platform === 'win32';
  const osRelease = os.release();
  checks.push({
    title: 'Hệ điều hành Windows (10/11)',
    ok: isWindows,
    detail: isWindows ? `Windows build ${osRelease}` : `Phát hiện: ${process.platform} (Swep chỉ hỗ trợ Windows)`,
  });

  // 2. Node.js version
  const nodeVersion = process.version;
  const major = parseInt(nodeVersion.replace(/^v/, '').split('.')[0], 10);
  checks.push({
    title: 'Node.js Runtime (>= 18.0.0)',
    ok: major >= 18,
    detail: `${nodeVersion} (yêu cầu: >= 18.0.0)`,
  });

  // 3. Trình duyệt Google Chrome
  const chromePath = await findChromePath();
  checks.push({
    title: 'Google Chrome',
    ok: !!chromePath,
    detail: chromePath ? `Tìm thấy tại: ${chromePath}` : 'Chưa cài đặt (Swep sẽ tự cài qua winget nếu cần)',
    warn: !chromePath,
  });

  // 4. Winget (Windows Package Manager)
  let wingetOk = false;
  let wingetVer = '';
  try {
    const { stdout } = await execAsync('winget --version');
    wingetOk = true;
    wingetVer = stdout.trim();
  } catch {
    wingetOk = false;
  }
  checks.push({
    title: 'Windows Package Manager (winget)',
    ok: wingetOk,
    detail: wingetOk ? `Phiên bản: ${wingetVer}` : 'Không tìm thấy winget trong PATH',
    warn: !wingetOk,
  });

  // 5. Quyền ghi vào thư mục gốc Swep
  const rootDir = getSwepRoot(options.root);
  let writeOk = false;
  try {
    if (!fs.existsSync(rootDir)) {
      fs.mkdirSync(rootDir, { recursive: true });
    }
    const testFile = path.join(rootDir, '.write-test');
    fs.writeFileSync(testFile, 'test', 'utf8');
    fs.unlinkSync(testFile);
    writeOk = true;
  } catch (err) {
    writeOk = false;
  }
  checks.push({
    title: 'Quyền ghi thư mục Swep (%LOCALAPPDATA%\\Swep)',
    ok: writeOk,
    detail: rootDir,
  });

  // 6. Kết nối mạng tới GitHub
  let githubOk = false;
  try {
    const { stdout } = await execAsync('powershell -NoProfile -Command "Test-NetConnection -ComputerName api.github.com -Port 443 -InformationLevel Quiet"');
    githubOk = stdout.trim().toLowerCase() === 'true';
  } catch {
    githubOk = false;
  }
  checks.push({
    title: 'Kết nối mạng tới GitHub API (port 443)',
    ok: githubOk,
    detail: githubOk ? 'Kết nối bình thường' : 'Không thể kết nối api.github.com',
  });

  // 7. Kết nối tới Swep Gate
  const gateOk = await defaultGate.healthCheck();
  checks.push({
    title: `Kết nối tới Swep Gate (${defaultGate.baseUrl})`,
    ok: gateOk,
    detail: gateOk ? 'Swep Gate đang phản hồi tốt' : 'Không kết nối được Swep Gate (chạy mock/local hoặc kiểm tra mạng)',
    warn: !gateOk,
  });

  // In kết quả
  let allPass = true;
  for (const c of checks) {
    if (c.ok) {
      console.log(`${chalk.green('✔')} ${chalk.bold(c.title)}: ${chalk.dim(c.detail)}`);
    } else if (c.warn) {
      console.log(`${chalk.yellow('⚠')} ${chalk.bold(c.title)}: ${chalk.yellow(c.detail)}`);
    } else {
      console.log(`${chalk.red('✖')} ${chalk.bold(c.title)}: ${chalk.red(c.detail)}`);
      allPass = false;
    }
  }

  console.log();
  if (allPass) {
    console.log(chalk.green.bold('🎉 Mọi kiểm tra cơ bản đều đạt! Máy tính của bạn đã sẵn sàng sử dụng Swep.'));
  } else {
    console.log(chalk.yellow.bold('⚠ Có một số mục cần lưu ý trước khi chạy swep.'));
  }
}
