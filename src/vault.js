/**
 * Vault Storage on GitHub (Zero Server Architecture)
 * Quản lý lưu trữ gói mã hóa trực tiếp trên GitHub repository `swep-vault` của người dùng
 */

import axios from 'axios';

/**
 * Tải file vault.json trực tiếp từ GitHub mà không cần token
 * @param {string} handle - GitHub username
 * @returns {Promise<object>} Dữ liệu vault đã mã hóa
 */
export async function fetchVault(handle) {
  const url = `https://raw.githubusercontent.com/${handle}/swep-vault/main/vault.json?t=${Date.now()}`;
  try {
    const res = await axios.get(url, {
      timeout: 10000,
      headers: {
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'User-Agent': 'swep-cli/0.1.0',
      },
    });
    return res.data;
  } catch (err) {
    if (err.response?.status === 404) {
      throw new Error(`Không tìm thấy vault của '${handle}'. Hãy kiểm tra lại username hoặc chạy 'swep register' trước.`);
    }
    throw new Error(`Không thể tải vault từ GitHub (${url}): ${err.message}`);
  }
}

/**
 * Tạo repository `swep-vault` trên GitHub của người dùng (nếu chưa có)
 * @param {string} token - GitHub Personal Access Token (PAT)
 * @returns {Promise<{ name: string, owner: string }>}
 */
export async function ensureVaultRepo(token) {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'swep-cli/0.1.0',
  };

  // 1. Kiểm tra repo đã tồn tại chưa
  try {
    const userRes = await axios.get('https://api.github.com/user', { headers });
    const handle = userRes.data.login.toLowerCase();

    try {
      const repoRes = await axios.get(`https://api.github.com/repos/${handle}/swep-vault`, { headers });
      return { name: repoRes.data.name, owner: handle };
    } catch (checkErr) {
      if (checkErr.response?.status !== 404) {
        throw checkErr;
      }
    }

    // 2. Tạo repo mới nếu chưa có
    const createRes = await axios.post(
      'https://api.github.com/user/repos',
      {
        name: 'swep-vault',
        description: 'Swep encrypted workplace vault (Protected by Argon2id & ChaCha20-Poly1305)',
        private: false, // Public để máy mượn đọc được trực tiếp không cần token
        auto_init: true,
      },
      { headers }
    );

    return { name: createRes.data.name, owner: handle };
  } catch (err) {
    const msg = err.response?.data?.message || err.message;
    throw new Error(`Lỗi khi tạo repository trên GitHub: ${msg}`);
  }
}

/**
 * Đẩy file vault.json đã mã hóa lên GitHub repository
 * @param {string} token - GitHub Personal Access Token
 * @param {string} handle - GitHub username
 * @param {object} encryptedVault - Object chứa nonce, ciphertext, tag, salt
 * @returns {Promise<boolean>}
 */
export async function uploadVaultToGitHub(token, handle, encryptedVault) {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'swep-cli/0.1.0',
  };

  const contentBase64 = Buffer.from(JSON.stringify(encryptedVault, null, 2), 'utf8').toString('base64');
  const filePath = 'vault.json';
  const url = `https://api.github.com/repos/${handle}/swep-vault/contents/${filePath}`;

  // Kiểm tra file đã có chưa để lấy SHA nếu cần cập nhật
  let existingSha = null;
  try {
    const res = await axios.get(url, { headers });
    existingSha = res.data.sha;
  } catch {
    // File chưa tồn tại
  }

  const payload = {
    message: 'chore: update encrypted swep vault',
    content: contentBase64,
  };
  if (existingSha) {
    payload.sha = existingSha;
  }

  try {
    await axios.put(url, payload, { headers });
    return true;
  } catch (err) {
    const msg = err.response?.data?.message || err.message;
    throw new Error(`Không thể upload vault.json lên GitHub: ${msg}`);
  }
}
