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
    console.error("error: no active workspace found. Run 'swep <code>' to start.");
    return;
  }

  const activeSession = readActiveSession(rootDir);
  const cdpPort = activeSession?.cdpPort || 0;

  try {
    const opened = await openSwepChrome(rootDir, 'https://www.google.com', cdpPort);
    if (opened) {
      console.log('Chrome reopened.');
    } else {
      console.error('error: unable to reopen Chrome.');
    }
  } catch (err) {
    console.error(`error: ${err.message}`);
  }
}
