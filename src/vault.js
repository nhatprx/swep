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
/**
 * Tải file vault.json trực tiếp từ GitHub mà không cần token
 * @param {string} handle - GitHub username
 * @param {string} [repoName='swep-vault']
 * @returns {Promise<object>} Dữ liệu vault đã mã hóa
 */
export async function fetchVault(handle, repoName = 'swep-vault') {
  const url = `https://raw.githubusercontent.com/${handle}/${repoName}/main/vault.json?t=${Date.now()}`;
  try {
    const res = await axios.get(url, {
      timeout: 10000,
      headers: {
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'User-Agent': 'swep-cli',
      },
    });
    return { ...res.data, _repo: repoName };
  } catch (err) {
    if (err.response?.status === 404 && repoName === 'swep-vault') {
      // Tìm thử các repo swep-vault-2, swep-vault-3... nếu có
      try {
        const reposRes = await axios.get(`https://api.github.com/users/${handle}/repos?sort=updated`, {
          headers: { 'User-Agent': 'swep-cli' },
          timeout: 5000,
        });
        const vaultRepos = reposRes.data.filter((r) => r.name.startsWith('swep-vault') && r.name !== 'swep-vault');
        for (const r of vaultRepos) {
          try {
            const altRes = await axios.get(`https://raw.githubusercontent.com/${handle}/${r.name}/main/vault.json?t=${Date.now()}`, {
              timeout: 5000,
              headers: { 'User-Agent': 'swep-cli' },
            });
            return { ...altRes.data, _repo: r.name };
          } catch {
            // continue
          }
        }
      } catch {
        // ignore
      }
    }
    throw new Error(`Vault not found for '${handle}' in ${repoName}.`);
  }
}

/**
 * Kiểm tra repository đã tồn tại trên GitHub chưa
 * @param {string} token
 * @param {string} handle
 * @param {string} [repoName='swep-vault']
 * @returns {Promise<boolean>}
 */
export async function checkVaultRepoExists(token, handle, repoName = 'swep-vault') {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'swep-cli',
  };
  try {
    const res = await axios.get(`https://api.github.com/repos/${handle}/${repoName}`, { headers });
    return res.status === 200;
  } catch (err) {
    if (err.response?.status === 404) return false;
    return false;
  }
}

/**
 * Tìm tên repository swep-vault tiếp theo chưa bị trùng (swep-vault-2, swep-vault-3, ...)
 * @param {string} token
 * @param {string} handle
 * @param {string} [baseName='swep-vault']
 * @returns {Promise<string>}
 */
export async function findNextVaultRepoName(token, handle, baseName = 'swep-vault') {
  let counter = 2;
  while (counter <= 50) {
    const candidate = `${baseName}-${counter}`;
    const exists = await checkVaultRepoExists(token, handle, candidate);
    if (!exists) return candidate;
    counter++;
  }
  return `${baseName}-${Date.now()}`;
}

/**
 * Tạo repository trên GitHub của người dùng (nếu chưa có)
 * @param {string} token - GitHub Personal Access Token (PAT)
 * @param {string} [repoName='swep-vault']
 * @returns {Promise<{ name: string, owner: string }>}
 */
export async function ensureVaultRepo(token, repoName = 'swep-vault') {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'swep-cli',
  };

  // 1. Kiểm tra repo đã tồn tại chưa
  try {
    const userRes = await axios.get('https://api.github.com/user', { headers });
    const handle = userRes.data.login.toLowerCase();

    try {
      const repoRes = await axios.get(`https://api.github.com/repos/${handle}/${repoName}`, { headers });
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
        name: repoName,
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
 * @param {string} [repoName='swep-vault']
 * @returns {Promise<boolean>}
 */
export async function uploadVaultToGitHub(token, handle, encryptedVault, repoName = 'swep-vault') {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'swep-cli',
  };

  const contentBase64 = Buffer.from(JSON.stringify(encryptedVault, null, 2), 'utf8').toString('base64');
  const filePath = 'vault.json';
  const url = `https://api.github.com/repos/${handle}/${repoName}/contents/${filePath}`;

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

/**
 * Tải file profile.capsule.enc từ GitHub Release
 * @param {string} handle - GitHub username
 * @param {string} [repoName='swep-vault']
 * @returns {Promise<Buffer|null>} Dữ liệu capsule đã mã hóa, hoặc null nếu chưa có
 */
export async function fetchProfileCapsuleFromGitHub(handle, repoName = 'swep-vault') {
  const downloadUrl = `https://github.com/${handle}/${repoName}/releases/download/capsule/profile.capsule.enc?t=${Date.now()}`;
  try {
    const res = await axios.get(downloadUrl, {
      responseType: 'arraybuffer',
      timeout: 30000,
      headers: {
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'User-Agent': 'swep-cli',
      },
    });
    return Buffer.from(res.data);
  } catch (err) {
    if (err.response?.status === 404) {
      return null; // Chưa có capsule
    }
    // Thử fallback qua API nếu có
    return null;
  }
}

/**
 * Đẩy file profile.capsule.enc lên GitHub Release tag "capsule"
 * @param {string} token - GitHub PAT
 * @param {string} handle - GitHub username
 * @param {Buffer} encryptedCapsuleBuffer - Binary capsule đã mã hóa AEAD
 * @param {string} [repoName='swep-vault']
 * @returns {Promise<boolean>}
 */
export async function uploadProfileCapsuleToGitHub(token, handle, encryptedCapsuleBuffer, repoName = 'swep-vault') {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'swep-cli',
  };

  // 1. Kiểm tra hoặc tạo release "capsule"
  let release;
  try {
    const relRes = await axios.get(`https://api.github.com/repos/${handle}/${repoName}/releases/tags/capsule`, { headers });
    release = relRes.data;
  } catch (err) {
    if (err.response?.status === 404) {
      const createRes = await axios.post(
        `https://api.github.com/repos/${handle}/${repoName}/releases`,
        {
          tag_name: 'capsule',
          name: 'Swep Profile Capsule',
          body: 'Encrypted workplace profile capsule (Argon2id & ChaCha20-Poly1305)',
        },
        { headers }
      );
      release = createRes.data;
    } else {
      throw err;
    }
  }

  // 2. Xóa asset cũ nếu đã tồn tại
  const assetName = 'profile.capsule.enc';
  if (Array.isArray(release.assets)) {
    const existing = release.assets.find((a) => a.name === assetName);
    if (existing) {
      try {
        await axios.delete(`https://api.github.com/repos/${handle}/${repoName}/releases/assets/${existing.id}`, { headers });
      } catch {
        // ignore
      }
    }
  }

  // 3. Upload asset mới
  const uploadUrl = `https://uploads.github.com/repos/${handle}/${repoName}/releases/${release.id}/assets?name=${encodeURIComponent(assetName)}`;
  try {
    await axios.post(uploadUrl, encryptedCapsuleBuffer, {
      headers: {
        ...headers,
        'Content-Type': 'application/octet-stream',
      },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      timeout: 120000,
    });
    return true;
  } catch (err) {
    const msg = err.response?.data?.message || err.message;
    throw new Error(`Lỗi upload capsule lên GitHub Releases: ${msg}`);
  }
}

