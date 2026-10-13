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

const version = '0.1.2';

program
  .name('swep')
  .description('Ephemeral workspace manager with isolated Chrome profiles')
  .version(version, '-v, -V, --version', 'Show version');

// Default command: swep <code>
program
  .command('up [code]', { isDefault: true })
  .alias('login')
  .description('Launch workspace with login code (default)')
  .option('--dry-run', 'Print actions without executing')
  .option('--root <path>', 'Workspace root directory')
  .action((code, options) => loginCommand(code, options));

// Chrome command
program
  .command('chrome')
  .alias('open')
  .description('Reopen active Chrome workspace window')
  .option('--root <path>', 'Workspace root directory')
  .action(chromeCommand);

// Exit command
program
  .command('exit')
  .alias('down')
  .description('Save session to GitHub and remove local workspace')
  .option('--dry-run', 'Print actions without executing')
  .option('--root <path>', 'Workspace root directory')
  .action(downCommand);

// Register command
program
  .command('register')
  .description('Register vault and generate login code')
  .option('--dry-run', 'Print actions without executing')
  .action(registerCommand);

// Recover command
program
  .command('recover')
  .description('Recover vault using Recovery Key')
  .option('--dry-run', 'Print actions without executing')
  .action(recoverCommand);

// Revoke command
program
  .command('revoke')
  .description('Revoke active login codes')
  .action(revokeCommand);

// Doctor command
program
  .command('doctor')
  .description('Check system prerequisites')
  .option('--root <path>', 'Workspace root directory')
  .action(doctorCommand);

program.parse(process.argv);
