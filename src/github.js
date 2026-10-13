/**
 * GitHub Device Flow Authentication
 * Dùng để xác thực sở hữu username GitHub khi đăng ký hoặc khôi phục
 */

import axios from 'axios';
import chalk from 'chalk';
import { createSpinner } from './ui.js';

// Default GitHub Client ID for Swep
const DEFAULT_CLIENT_ID = process.env.GITHUB_CLIENT_ID || 'Iv23liSwepDefaultAppId';

/**
 * Bắt đầu device flow: lấy device code và user code
 * @param {string} [clientId]
 * @returns {Promise<{ device_code: string, user_code: string, verification_uri: string, interval: number }>}
 */
export async function startDeviceFlow(clientId = DEFAULT_CLIENT_ID) {
  try {
    const res = await axios.post(
      'https://github.com/login/device/code',
      {
        client_id: clientId,
        scope: 'read:user',
      },
      {
        headers: { Accept: 'application/json' },
        timeout: 10000,
      }
    );
    return res.data;
  } catch (err) {
    if (err.response) {
      throw new Error(`GitHub device flow failed: ${err.response.data?.error_description || err.response.statusText}`);
    }
    throw new Error(`Không thể kết nối đến GitHub: ${err.message}`);
  }
}

/**
 * Polling chờ người dùng xác nhận trên trình duyệt
 * @param {string} deviceCode
 * @param {number} interval
 * @param {string} [clientId]
 * @returns {Promise<string>} GitHub access token
 */
export async function pollForToken(deviceCode, interval = 5, clientId = DEFAULT_CLIENT_ID) {
  const spinner = createSpinner('Đang chờ bạn xác nhận trên GitHub...');
  let pollInterval = (interval || 5) * 1000;

  try {
    while (true) {
      await new Promise((r) => setTimeout(r, pollInterval));

      try {
        const res = await axios.post(
          'https://github.com/login/oauth/access_token',
          {
            client_id: clientId,
            device_code: deviceCode,
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          },
          {
            headers: { Accept: 'application/json' },
            timeout: 10000,
          }
        );

        const data = res.data;
        if (data.access_token) {
          spinner.succeed(chalk.green('Xác thực GitHub thành công!'));
          return data.access_token;
        }

        if (data.error === 'authorization_pending') {
          continue;
        } else if (data.error === 'slow_down') {
          pollInterval += 5000;
        } else if (data.error === 'expired_token') {
          spinner.fail(chalk.red('Mã xác nhận đã hết hạn.'));
          throw new Error('Mã xác nhận GitHub đã hết hạn. Vui lòng thử lại.');
        } else if (data.error === 'access_denied') {
          spinner.fail(chalk.red('Bạn đã từ chối cấp quyền trên GitHub.'));
          throw new Error('Bạn đã hủy xác thực GitHub.');
        } else {
          spinner.fail(chalk.red(`Lỗi xác thực: ${data.error_description || data.error}`));
          throw new Error(data.error_description || data.error);
        }
      } catch (pollErr) {
        if (pollErr.response?.data?.error === 'authorization_pending') {
          continue;
        }
        throw pollErr;
      }
    }
  } catch (err) {
    spinner.fail();
    throw err;
  }
}

/**
 * Lấy thông tin user (handle, id) từ GitHub token
 * @param {string} token
 * @returns {Promise<{ handle: string, github_id: number }>}
 */
export async function getGitHubUser(token) {
  try {
    const res = await axios.get('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${token}`,
        'User-Agent': 'swep-cli/0.1.0',
        Accept: 'application/vnd.github+json',
      },
      timeout: 10000,
    });
    return {
      handle: res.data.login.toLowerCase(),
      github_id: res.data.id,
    };
  } catch (err) {
    throw new Error(`Không lấy được thông tin người dùng từ GitHub: ${err.message}`);
  }
}
