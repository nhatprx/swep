/**
 * Command: revoke (Zero-Server GitHub Architecture)
 * Kill switch: Vô hiệu hóa toàn bộ mã đăng nhập hiện tại, bắt buộc dùng Recovery Key để mở lại
 */

import chalk from 'chalk';
import ora from 'ora';
import { promptConfirm, promptSecret } from '../ui.js';
import { fetchVault, uploadVaultToGitHub } from '../vault.js';
import { getGitHubUser } from '../github.js';
import { getSwepRoot } from '../chrome.js';
import { readActiveSession, removeActiveSession } from '../bridge.js';
import { performCleanup } from '../cleanup.js';

export async function revokeCommand(options = {}) {
  const confirm = await promptConfirm('Revoke all active login codes immediately? (This will disable all login codes)', false);
  if (!confirm) {
    return;
  }

  const rootDir = getSwepRoot(options.root);
  const activeSession = readActiveSession(rootDir);

  let token = activeSession?.github_pat || '';
  let handle = activeSession?.handle || '';

  if (!token) {
    token = await promptSecret('Enter your GitHub Personal Access Token');
    if (!token) {
      console.error('error: GitHub token is required to revoke vault');
      return;
    }

    try {
      const user = await getGitHubUser(token);
      handle = user.handle;
    } catch (err) {
      console.error(`error: invalid GitHub token (${err.message})`);
      return;
    }
  }

  const spinner = ora({
    text: `Fetching vault for ${handle}...`,
    color: 'cyan',
    spinner: 'dots',
  }).start();

  let vaultData;
  try {
    vaultData = await fetchVault(handle);
  } catch (err) {
    spinner.stop();
    console.error(`error: unable to fetch vault (${err.message})`);
    return;
  }

  spinner.text = 'Revoking all login codes...';

  // Vô hiệu hóa wrap_code
  vaultData.wrap_code = {
    revoked: true,
    revoked_at: new Date().toISOString(),
  };
  vaultData.updated_at = new Date().toISOString();

  try {
    const targetRepo = vaultData._repo || 'swep-vault';
    await uploadVaultToGitHub(token, handle, vaultData, targetRepo);

    // Dọn dẹp phiên cục bộ nếu có
    if (activeSession) {
      await performCleanup(rootDir, { selfDestruct: false });
      removeActiveSession(rootDir);
    }

    spinner.stop();
    console.log();
    console.log(chalk.yellow.bold('All active login codes have been revoked!'));
    console.log('The vault cannot be unlocked with any previously generated login code.');
    console.log("Run 'swep recover' with your Recovery Key to regain access and create a new login code.\n");
  } catch (err) {
    spinner.stop();
    console.error(`error: failed to revoke vault on GitHub (${err.message})`);
  }
}
