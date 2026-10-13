/**
 * Command: update
 * Check and update Swep to the latest version from npm
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import ora from 'ora';
import axios from 'axios';

const execAsync = promisify(exec);

function isNewer(latest, current) {
  const parse = (v) => v.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const [lMaj, lMin, lPat] = parse(latest);
  const [cMaj, cMin, cPat] = parse(current);
  if (lMaj !== cMaj) return lMaj > cMaj;
  if (lMin !== cMin) return lMin > cMin;
  return lPat > cPat;
}

export async function updateCommand(currentVersion = '0.1.3') {
  const spinner = ora({
    text: 'Checking for updates...',
    color: 'cyan',
    spinner: 'dots',
  }).start();

  let latestVersion = '';

  try {
    const res = await axios.get('https://registry.npmjs.org/@nhatprx/swep/latest', {
      timeout: 8000,
      headers: { 'User-Agent': 'swep-cli' },
    });
    latestVersion = res.data.version;
  } catch {
    try {
      const { stdout } = await execAsync('npm view @nhatprx/swep version');
      latestVersion = stdout.trim();
    } catch (err) {
      spinner.stop();
      console.error(`error: unable to check for updates (${err.message})`);
      return;
    }
  }

  if (!latestVersion) {
    spinner.stop();
    console.error('error: unable to determine latest version.');
    return;
  }

  if (!isNewer(latestVersion, currentVersion)) {
    spinner.stop();
    console.log(`Swep is already up to date (v${currentVersion}).`);
    return;
  }

  spinner.text = `Updating Swep from v${currentVersion} to v${latestVersion}...`;

  try {
    await execAsync('npm install -g @nhatprx/swep@latest');
    spinner.stop();
    console.log(`Updated Swep to v${latestVersion}.`);
  } catch (err) {
    spinner.stop();
    console.error(`error: update failed (${err.message})`);
  }
}
