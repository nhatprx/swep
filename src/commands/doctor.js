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
  const checks = [];

  // 1. OS check
  const isWindows = process.platform === 'win32';
  const osRelease = os.release();
  checks.push({
    title: 'Windows OS',
    ok: isWindows,
    detail: isWindows ? `build ${osRelease}` : `detected ${process.platform} (Windows required)`,
  });

  // 2. Node.js version
  const nodeVersion = process.version;
  const major = parseInt(nodeVersion.replace(/^v/, '').split('.')[0], 10);
  checks.push({
    title: 'Node.js runtime',
    ok: major >= 18,
    detail: `${nodeVersion} (>= 18.0.0 required)`,
  });

  // 3. Browser
  const browserPath = await findChromePath();
  checks.push({
    title: 'Supported browser',
    ok: !!browserPath,
    detail: browserPath ? browserPath : 'not installed (will auto-install via winget)',
    warn: !browserPath,
  });

  // 4. Winget
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
    detail: wingetOk ? `v${wingetVer}` : 'not found in PATH',
    warn: !wingetOk,
  });

  // 5. Write permissions
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
  } catch {
    writeOk = false;
  }
  checks.push({
    title: 'Workspace permissions',
    ok: writeOk,
    detail: rootDir,
  });

  // 6. GitHub connectivity
  let githubOk = false;
  try {
    const { stdout } = await execAsync('powershell -NoProfile -Command "Test-NetConnection -ComputerName api.github.com -Port 443 -InformationLevel Quiet"');
    githubOk = stdout.trim().toLowerCase() === 'true';
  } catch {
    githubOk = false;
  }
  checks.push({
    title: 'GitHub API connectivity',
    ok: githubOk,
    detail: githubOk ? 'reachable' : 'unable to reach api.github.com',
  });

  // 7. Swep Gate connectivity
  const gateOk = await defaultGate.healthCheck();
  checks.push({
    title: `Swep Gate (${defaultGate.baseUrl})`,
    ok: gateOk,
    detail: gateOk ? 'reachable' : 'unreachable',
    warn: !gateOk,
  });

  let allPass = true;
  for (const c of checks) {
    const tag = c.ok ? '[ok]  ' : (c.warn ? '[warn]' : '[fail]');
    console.log(`${tag} ${c.title}: ${c.detail}`);
    if (!c.ok && !c.warn) allPass = false;
  }

  if (allPass) {
    console.log('System check passed.');
  } else {
    console.log('System check completed with errors.');
  }
}
