/**
 * Command: open
 * Reopen active workspace browser window
 */

import fs from 'fs';
import path from 'path';
import ora from 'ora';
import chalk from 'chalk';
import { getSwepRoot, openSwepBrowser } from '../chrome.js';
import { getActiveKey } from '../bridge.js';
import { spawnWatchdog } from '../watchdog.js';

export async function openCommand(options = {}) {
  const rootDir = getSwepRoot(options.root);
  const active = getActiveKey(rootDir);

  if (!active) {
    console.error("error: no active workspace found. Run 'swep <code>' to start.");
    return;
  }

  console.log(chalk.dim('key-id: ') + chalk.cyan(active.maskedKey));

  const spinner = ora({
    text: 'Reopening browser...',
    color: 'cyan',
    spinner: 'dots',
  }).start();

  const cdpPort = active.session?.cdpPort || 0;

  try {
    const opened = await openSwepBrowser(rootDir, 'https://www.google.com', cdpPort);
    spinner.stop();
    if (opened) {
      console.log('Browser reopened.');
      await spawnWatchdog(rootDir, process.ppid);
    } else {
      console.error('error: unable to reopen browser.');
    }
  } catch (err) {
    spinner.stop();
    console.error(`error: ${err.message}`);
  }
}

export const chromeCommand = openCommand;
