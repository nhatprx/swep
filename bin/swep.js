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
  openCommand,
  chromeCommand,
  checkoutCommand,
  updateCommand,
} from '../src/commands/index.js';
import { runWatchdog, silentCheckout } from '../src/watchdog.js';
import { getSwepRoot } from '../src/chrome.js';

// Internal Watchdog Worker Entry
if (process.argv[2] === '_watchdog') {
  const terminalPid = process.argv[3];
  const rootDir = process.argv[4] || getSwepRoot();
  runWatchdog(terminalPid, rootDir);
} else {
  // Graceful termination handling: auto-checkout on abrupt terminal signals
  const onSignal = async () => {
    try {
      await silentCheckout(getSwepRoot());
    } catch {
      // ignore
    }
    process.exit(0);
  };

  process.on('SIGINT', onSignal);
  process.on('SIGBREAK', onSignal);
  process.on('SIGHUP', onSignal);

  const version = '0.1.5';

  program
    .name('swep')
    .description('Ephemeral workspace manager with isolated browser profiles')
    .version(version, '-v, -V, --version', 'Show version');

  // Default command: swep <code>
  program
    .command('up [code]', { isDefault: true })
    .alias('login')
    .description('Launch workspace with login code (default)')
    .option('--browser <name>', 'Preferred browser (chrome, edge, brave)')
    .option('--dry-run', 'Print actions without executing')
    .option('--root <path>', 'Workspace root directory')
    .action((code, options) => loginCommand(code, options));

  // Open command: swep open
  program
    .command('open')
    .alias('chrome')
    .description('Reopen active workspace browser window')
    .option('--root <path>', 'Workspace root directory')
    .action(openCommand);

  // Checkout command: swep checkout (log out key, purge profile, keep swep core)
  program
    .command('checkout')
    .description('Log out current key, clean profile, keep swep installed')
    .option('--dry-run', 'Print actions without executing')
    .option('--root <path>', 'Workspace root directory')
    .action(checkoutCommand);

  // Exit command: swep exit (save session, purge profile and self-destruct swep)
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

  // Update command
  program
    .command('update')
    .description('Check and update Swep to the latest version')
    .action(() => updateCommand(version));

  program.parse(process.argv);
}
