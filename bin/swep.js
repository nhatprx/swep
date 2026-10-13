#!/usr/bin/env node

/**
 * Swep CLI - Main entry point
 * Một lệnh để bắt đầu → nhập mã cá nhân → Chrome đã đăng nhập Google
 */

import { program } from 'commander';
import chalk from 'chalk';
import {
  registerCommand,
  loginCommand,
  downCommand,
  recoverCommand,
  revokeCommand,
  doctorCommand,
  chromeCommand,
} from '../src/commands/index.js';

const version = '0.1.0';

program
  .name('swep')
  .description(chalk.bold('Swep: Temporary Chrome profile with Google login'))
  .version(version);

// Register command
program
  .command('register')
  .description('Đăng ký lần đầu (cần GitHub + Google account riêng cho công việc)')
  .option('--dry-run', 'Chỉ in ra, không thực hiện')
  .action(registerCommand);

// Login/up command (default)
program
  .command('up', { isDefault: true })
  .alias('login')
  .description('Đăng nhập bằng mã, xoay mã, mở Chrome (mặc định)')
  .option('--dry-run', 'Chỉ in ra, không thực hiện')
  .option('--root <path>', 'Đường dẫn thư mục gốc (mặc định: %LOCALAPPDATA%\\Swep)')
  .action(loginCommand);

// Chrome command (re-open isolated Chrome)
program
  .command('chrome')
  .alias('open')
  .description('Mở lại cửa sổ Chrome của Swep (không ảnh hưởng Chrome của máy)')
  .option('--root <path>', 'Đường dẫn thư mục gốc')
  .action(chromeCommand);

// Down command
program
  .command('down')
  .description('Dọn sạch: đóng Chrome, xóa profile, gỡ app đã cài, báo cáo')
  .option('--dry-run', 'Chỉ in ra, không thực hiện')
  .option('--root <path>', 'Đường dẫn thư mục gốc')
  .action(downCommand);

// Recover command
program
  .command('recover')
  .description('Khôi phục khi mất mã (khóa khôi phục + GitHub)')
  .option('--dry-run', 'Chỉ in ra, không thực hiện')
  .action(recoverCommand);

// Revoke command
program
  .command('revoke')
  .description('Kill switch: vô hiệu hóa toàn bộ mã hiện tại')
  .action(revokeCommand);

// Doctor command
program
  .command('doctor')
  .description('Kiểm tra điều kiện máy, không thay đổi gì')
  .option('--root <path>', 'Đường dẫn thư mục gốc')
  .action(doctorCommand);

program.parse(process.argv);
