/**
 * Command: register (Zero-Server GitHub Architecture)
 * Đăng ký tài khoản: Mở Chromium hoàn toàn mới để đăng nhập GitHub,
 * tạo kho lưu trữ swep-vault và lưu gói dữ liệu đã mã hóa lên GitHub của bạn
 */

import crypto from 'crypto';
import chalk from 'chalk';
import ora from 'ora';
import { printBanner, printBox, prompt, promptSecret, promptConfirm, createSpinner } from '../ui.js';
import { openCleanBrowserForGitHub, getClipboardText } from '../chrome.js';
import { getGitHubUser } from '../github.js';
import {
  ensureVaultRepo,
  uploadVaultToGitHub,
  checkVaultRepoExists,
} from '../vault.js';
import {
  generateDEK,
  generateCode,
  normalizeCode,
  deriveSeed,
  hkdf,
  aead_encrypt,
  generateRecoveryKey,
  deriveRecoveryKeyBuffer,
} from '../crypto.js';

export async function registerCommand(options) {
  const tokenUrl = 'https://github.com/settings/tokens/new?description=Swep+Vault+Access&scopes=public_repo';

  try {
    await openCleanBrowserForGitHub(tokenUrl);
  } catch {
    console.log(`Open token URL: ${tokenUrl}`);
  }

  let cleanToken = '';
  let handle = '';

  while (true) {
    const clipboardText = await getClipboardText();
    if (clipboardText && (clipboardText.startsWith('ghp_') || clipboardText.startsWith('github_pat_'))) {
      const useClip = await promptConfirm(`Use token from clipboard (${clipboardText.slice(0, 8)}...)?`, true);
      if (useClip) {
        cleanToken = clipboardText;
      }
    }

    if (!cleanToken) {
      const entered = await promptSecret('Enter GitHub Personal Access Token (or "exit" to cancel)');
      if (entered.trim().toLowerCase() === 'exit' || entered.trim().toLowerCase() === 'q') {
        return;
      }
      cleanToken = entered.trim();
    }

    if (!cleanToken || (!cleanToken.startsWith('ghp_') && !cleanToken.startsWith('github_pat_'))) {
      console.error('error: invalid token format (expected ghp_... or github_pat_...)');
      cleanToken = '';
      continue;
    }

    const spinCheck = ora({
      text: 'Validating GitHub token...',
      color: 'cyan',
      spinner: 'dots',
    }).start();

    try {
      const user = await getGitHubUser(cleanToken);
      handle = user.handle;
      spinCheck.stop();
      break;
    } catch (err) {
      spinCheck.stop();
      console.error(`error: invalid token (${err.message})`);
      cleanToken = '';
    }
  }

  // Check if repository already exists on GitHub
  const targetRepo = 'swep-vault';
  const repoExists = await checkVaultRepoExists(cleanToken, handle, targetRepo);

  if (repoExists) {
    console.log();
    console.log(chalk.yellow(`Repository 'swep-vault' already exists on https://github.com/${handle}/swep-vault`));
    const overwrite = await promptConfirm('Do you want to overwrite the existing vault?', false);

    if (!overwrite) {
      console.log();
      console.log(chalk.yellow('Registration aborted to prevent cryptographic and data conflicts.'));
      console.log('Please delete or rename your existing repository on GitHub:');
      console.log(chalk.cyan(`  https://github.com/${handle}/swep-vault/settings`));
      console.log("Then run 'swep register' again to create a clean vault.\n");
      return;
    }
  }

  const spinner = ora({
    text: 'Generating client-side encryption keys...',
    color: 'cyan',
    spinner: 'dots',
  }).start();

  const dek = generateDEK();
  const rawPayload = {
    handle,
    github_pat: cleanToken,
    session: null,
    created_at: new Date().toISOString(),
    version: 1,
  };
  const aadPayload = `${handle}/1`;
  const encryptedPayload = aead_encrypt(dek, rawPayload, aadPayload);

  const rawCode = generateCode(10);
  const normalizedCode = normalizeCode(rawCode);

  const saltBuf = crypto.randomBytes(16);
  const saltHex = saltBuf.toString('hex');
  const seed = await deriveSeed(normalizedCode, handle, saltBuf);
  const codeKey = hkdf(seed, 'swep/wrap');
  const wrapCode = aead_encrypt(codeKey, { dek: dek.toString('hex') }, `${handle}/code`);

  const recoveryKey = generateRecoveryKey();
  const recoveryKeyBuf = deriveRecoveryKeyBuffer(recoveryKey);
  const wrapRecovery = aead_encrypt(recoveryKeyBuf, { dek: dek.toString('hex') }, `${handle}/recovery`);

  const vaultData = {
    handle,
    version: 2,
    salt: saltHex,
    wrap_code: wrapCode,
    wrap_recovery: wrapRecovery,
    payload: encryptedPayload,
    updated_at: new Date().toISOString(),
  };

  if (!options.dryRun) {
    spinner.text = `Initializing ${targetRepo} repository on GitHub...`;
    try {
      await ensureVaultRepo(cleanToken, targetRepo);
      spinner.text = `Uploading encrypted vault to GitHub (${targetRepo})...`;
      await uploadVaultToGitHub(cleanToken, handle, vaultData, targetRepo);
    } catch (err) {
      spinner.stop();
      console.error(`error: ${err.message}`);
      return;
    }
  }

  spinner.stop();

  const fullLoginCode = `${handle}-${rawCode}`;

  console.log();
  console.log(chalk.dim('  login code:   ') + chalk.bold.green(fullLoginCode));
  console.log(chalk.dim('  recovery key: ') + chalk.bold.yellow(recoveryKey));
  console.log(chalk.dim('  vault repo:   ') + chalk.cyan(`https://github.com/${handle}/${targetRepo}`));
  console.log();
  console.log(`Registered. Run 'swep ${chalk.bold.green(fullLoginCode)}' to start workspace.\n`);
}
