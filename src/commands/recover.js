/**
 * Command: recover (Zero-Server GitHub Architecture)
 * Khôi phục quyền truy cập vault khi mất mã đăng nhập bằng Recovery Key
 */

import crypto from 'crypto';
import chalk from 'chalk';
import ora from 'ora';
import { prompt, promptSecret } from '../ui.js';
import { fetchVault, uploadVaultToGitHub } from '../vault.js';
import {
  generateCode,
  normalizeCode,
  deriveSeed,
  hkdf,
  aead_encrypt,
  aead_decrypt,
  deriveRecoveryKeyBuffer,
} from '../crypto.js';

export async function recoverCommand(options = {}) {
  let handle = '';
  if (options.handle) {
    handle = options.handle.trim().toLowerCase();
  } else {
    handle = (await prompt('Enter your GitHub username')).trim().toLowerCase();
  }

  if (!handle) {
    console.error('error: GitHub username is required');
    return;
  }

  const recoveryKey = await promptSecret('Enter Recovery Key (e.g. 4F8Q-2P9K-L7R3-M5X8)');
  if (!recoveryKey) {
    console.error('error: recovery key cannot be empty');
    return;
  }

  const spinner = ora({
    text: `Fetching encrypted vault for ${handle}...`,
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

  spinner.text = 'Verifying Recovery Key and decrypting vault...';

  const recoveryKeyBuf = deriveRecoveryKeyBuffer(recoveryKey);
  let dek;
  let userPayload;

  try {
    const dekObj = aead_decrypt(recoveryKeyBuf, vaultData.wrap_recovery, `${handle}/recovery`);
    dek = Buffer.from(dekObj.dek, 'hex');
    userPayload = aead_decrypt(dek, vaultData.payload, `${handle}/1`);
  } catch (err) {
    spinner.stop();
    console.error('error: invalid Recovery Key or corrupted vault.');
    return;
  }

  if (!userPayload?.github_pat) {
    spinner.stop();
    console.error('error: decrypted payload does not contain GitHub token.');
    return;
  }

  spinner.text = 'Generating new login code and re-encrypting vault...';

  const newRawCode = generateCode(10);
  const newNormalizedCode = normalizeCode(newRawCode);
  const newSaltBuf = crypto.randomBytes(16);
  const newSaltHex = newSaltBuf.toString('hex');

  const newSeed = await deriveSeed(newNormalizedCode, handle, newSaltBuf);
  const newCodeKey = hkdf(newSeed, 'swep/wrap');
  const newWrapCode = aead_encrypt(newCodeKey, { dek: dek.toString('hex') }, `${handle}/code`);

  vaultData.wrap_code = newWrapCode;
  vaultData.salt = newSaltHex;
  vaultData.updated_at = new Date().toISOString();

  spinner.text = 'Uploading updated vault to GitHub...';

  try {
    const targetRepo = vaultData._repo || 'swep-vault';
    await uploadVaultToGitHub(userPayload.github_pat, handle, vaultData, targetRepo);
    spinner.stop();

    const fullLoginCode = `${handle}-${newRawCode}`;
    console.log();
    console.log(chalk.green.bold('Account recovered successfully!'));
    console.log(chalk.dim('  new login code: ') + chalk.bold.green(fullLoginCode));
    console.log();
    console.log(`Run 'swep ${chalk.bold.green(fullLoginCode)}' or simply 'swep' to start workspace.\n`);
  } catch (err) {
    spinner.stop();
    console.error(`error: failed to update vault on GitHub (${err.message})`);
  }
}
