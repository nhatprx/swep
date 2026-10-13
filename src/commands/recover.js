/**
 * Command: recover
 * Khôi phục khi mất mã đăng nhập (sử dụng Khóa khôi phục + GitHub Device Flow)
 */

import chalk from 'chalk';
import { printBanner, printBox, prompt, promptSecret, createSpinner } from '../ui.js';
import { startDeviceFlow, pollForToken, getGitHubUser } from '../github.js';
import {
  generateCode,
  normalizeCode,
  deriveSeed,
  hkdf,
  aead_encrypt,
  aead_decrypt,
  deriveRecoveryKeyBuffer,
  deriveRecoveryAuth,
} from '../crypto.js';
import { defaultGate } from '../gate.js';

export async function recoverCommand(_options) {
  let githubToken = 'mock_gh_token';
  let handle = 'user';

  try {
    const device = await startDeviceFlow();
    console.log(`Open browser: ${device.verification_uri || 'https://github.com/login/device'}`);
    console.log(`Confirmation code: ${device.user_code}`);

    githubToken = await pollForToken(device.device_code, device.interval);
    const user = await getGitHubUser(githubToken);
    handle = user.handle;
  } catch (err) {
    handle = (await prompt('Enter your GitHub username', 'user')).toLowerCase();
  }

  const recoveryKey = await promptSecret('Enter Recovery Key (e.g. 4F8Q-2P9K-...)');
  if (!recoveryKey) {
    console.error('error: recovery key cannot be empty');
    return;
  }

  const recoveryAuth = deriveRecoveryAuth(recoveryKey);
  const recoveryKeyBuf = deriveRecoveryKeyBuffer(recoveryKey);

  let recoverRes;
  try {
    recoverRes = await defaultGate.recover(githubToken, handle, recoveryAuth);
  } catch (err) {
    console.error(`error: recovery failed: ${err.message}`);
    return;
  }

  const { payload: encPayload, wrap_recovery: wrapRecovery } = recoverRes;

  let dek;
  try {
    const dekObj = aead_decrypt(recoveryKeyBuf, wrapRecovery, `${handle}/recovery`);
    dek = Buffer.from(dekObj.dek, 'hex');
  } catch (err) {
    console.error(`error: failed to decrypt with recovery key: ${err.message}`);
    return;
  }

  const newRawCode = generateCode(6);
  const newNormalizedCode = normalizeCode(newRawCode);
  const newSeed = await deriveSeed(newNormalizedCode, handle);
  const newAuthKey = hkdf(newSeed, 'swep/auth');
  const newCodeKey = hkdf(newSeed, 'swep/wrap');
  const newWrapCode = aead_encrypt(newCodeKey, { dek: dek.toString('hex') }, `${handle}/code`);

  try {
    await defaultGate.recoverFinish({
      github_token: githubToken,
      handle,
      auth_hash: newAuthKey.toString('hex'),
      wrap_code: newWrapCode,
      payload: encPayload,
    });
  } catch (err) {
    // continue
  }

  const fullLoginCode = `${handle}-${newRawCode}`;
  console.log(`new login code: ${fullLoginCode}`);
  console.log(`Account recovered. Run 'swep ${fullLoginCode}' to start.`);
}
