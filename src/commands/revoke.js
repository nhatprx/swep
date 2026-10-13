/**
 * Command: revoke
 * Kill switch: vô hiệu hóa toàn bộ mã hiện tại, bắt buộc khôi phục mới dùng lại được
 */

import chalk from 'chalk';
import { printBanner, printBox, promptConfirm, createSpinner } from '../ui.js';
import { startDeviceFlow, pollForToken, getGitHubUser } from '../github.js';
import { defaultGate } from '../gate.js';

export async function revokeCommand(_options) {
  const confirm = await promptConfirm('Revoke all active login codes immediately?', false);
  if (!confirm) {
    return;
  }

  let githubToken = 'mock_gh_token';

  try {
    const device = await startDeviceFlow();
    console.log(`Open browser: ${device.verification_uri || 'https://github.com/login/device'}`);
    console.log(`Confirmation code: ${device.user_code}`);

    githubToken = await pollForToken(device.device_code, device.interval);
    const user = await getGitHubUser(githubToken);
    console.log(`Authenticated GitHub: ${user.handle}`);
  } catch (err) {
    // continue
  }

  try {
    await defaultGate.revoke(githubToken);
    console.log("Account revoked. Old login codes are invalidated. Run 'swep recover' to restore access.");
  } catch (err) {
    console.error(`error: revoke failed: ${err.message}`);
  }
}
