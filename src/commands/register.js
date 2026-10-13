/**
 * Command: register (Zero-Server GitHub Architecture)
 * Đăng ký tài khoản: Mở Chromium hoàn toàn mới để đăng nhập GitHub,
 * tạo kho lưu trữ swep-vault và lưu gói dữ liệu đã mã hóa lên GitHub của bạn
 */

import chalk from 'chalk';
import { printBanner, printBox, prompt, promptConfirm, createSpinner } from '../ui.js';
import { openCleanBrowserForGitHub, getClipboardText } from '../chrome.js';
import { getGitHubUser } from '../github.js';
import { ensureVaultRepo, uploadVaultToGitHub } from '../vault.js';
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
      const entered = await prompt('Enter GitHub Personal Access Token (or "exit" to cancel)');
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

    try {
      const user = await getGitHubUser(cleanToken);
      handle = user.handle;
      break;
    } catch (err) {
      console.error(`error: invalid token: ${err.message}`);
      cleanToken = '';
    }
  }

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

  const seed = await deriveSeed(normalizedCode, handle);
  const codeKey = hkdf(seed, 'swep/wrap');
  const wrapCode = aead_encrypt(codeKey, { dek: dek.toString('hex') }, `${handle}/code`);

  const recoveryKey = generateRecoveryKey();
  const recoveryKeyBuf = deriveRecoveryKeyBuffer(recoveryKey);
  const wrapRecovery = aead_encrypt(recoveryKeyBuf, { dek: dek.toString('hex') }, `${handle}/recovery`);

  const vaultData = {
    handle,
    version: 1,
    wrap_code: wrapCode,
    wrap_recovery: wrapRecovery,
    payload: encryptedPayload,
    updated_at: new Date().toISOString(),
  };

  if (!options.dryRun) {
    try {
      await ensureVaultRepo(cleanToken);
      await uploadVaultToGitHub(cleanToken, handle, vaultData);
    } catch (err) {
      console.error(`error: ${err.message}`);
      return;
    }
  }

  const fullLoginCode = `${handle}-${rawCode}`;
  console.log(`login code:   ${fullLoginCode}`);
  console.log(`recovery key: ${recoveryKey}`);
  console.log(`vault repo:   https://github.com/${handle}/swep-vault`);
  console.log(`Registered. Run 'swep ${fullLoginCode}' to start.`);
}
