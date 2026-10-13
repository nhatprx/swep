/**
 * Command: open
 * Reopen active workspace browser window
 */

import fs from 'fs';
import path from 'path';
import ora from 'ora';
import { getSwepRoot, openSwepBrowser } from '../chrome.js';
import { readActiveSession } from '../bridge.js';

export async function openCommand(options = {}) {
  const rootDir = getSwepRoot(options.root);
  const profileDir = path.join(rootDir, 'chrome-profile');

  if (!fs.existsSync(profileDir)) {
    console.error("error: no active workspace found. Run 'swep <code>' to start.");
    return;
  }

  const spinner = ora({
    text: 'Reopening browser...',
    color: 'cyan',
    spinner: 'dots',
  }).start();

  const activeSession = readActiveSession(rootDir);
  const cdpPort = activeSession?.cdpPort || 0;

  try {
    const opened = await openSwepBrowser(rootDir, 'https://www.google.com', cdpPort);
    spinner.stop();
    if (opened) {
      console.log('Browser reopened.');
    } else {
      console.error('error: unable to reopen browser.');
    }
  } catch (err) {
    spinner.stop();
    console.error(`error: ${err.message}`);
  }
}

export const chromeCommand = openCommand;
