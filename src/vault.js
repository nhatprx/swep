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

/**
 * Tải file profile.capsule.enc từ GitHub Release
 * @param {string} handle - GitHub username
 * @returns {Promise<Buffer|null>} Dữ liệu capsule đã mã hóa, hoặc null nếu chưa có
 */
export async function fetchProfileCapsuleFromGitHub(handle) {
  const downloadUrl = `https://github.com/${handle}/swep-vault/releases/download/capsule/profile.capsule.enc?t=${Date.now()}`;
  try {
    const res = await axios.get(downloadUrl, {
      responseType: 'arraybuffer',
      timeout: 30000,
      headers: {
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'User-Agent': 'swep-cli/0.1.0',
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
 * @returns {Promise<boolean>}
 */
export async function uploadProfileCapsuleToGitHub(token, handle, encryptedCapsuleBuffer) {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'swep-cli/0.1.0',
  };

  // 1. Kiểm tra hoặc tạo release "capsule"
  let release;
  try {
    const relRes = await axios.get(`https://api.github.com/repos/${handle}/swep-vault/releases/tags/capsule`, { headers });
    release = relRes.data;
  } catch (err) {
    if (err.response?.status === 404) {
      const createRes = await axios.post(
        `https://api.github.com/repos/${handle}/swep-vault/releases`,
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
        await axios.delete(`https://api.github.com/repos/${handle}/swep-vault/releases/assets/${existing.id}`, { headers });
      } catch {
        // ignore
      }
    }
  }

  // 3. Upload asset mới
  const uploadUrl = `https://uploads.github.com/repos/${handle}/swep-vault/releases/${release.id}/assets?name=${encodeURIComponent(assetName)}`;
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

/**
 * Kiểm tra trạng thái khóa phiên đồng thời (Distributed Session Concurrency Lock)
 * @param {object} vaultData
 * @returns {{ locked: boolean, isStale: boolean, lock: object|null }}
 */
export function checkSessionLock(vaultData) {
  if (!vaultData || !vaultData.lock || !vaultData.lock.active) {
    return { locked: false, isStale: false, lock: null };
  }

  const now = Date.now();
  const expiresAt = new Date(vaultData.lock.expires_at).getTime();

  if (now >= expiresAt) {
    // Khóa đã hết hạn (stale lease lock do máy trước bị tắt đột ngột/mất nguồn)
    return { locked: false, isStale: true, lock: vaultData.lock };
  }

  return { locked: true, isStale: false, lock: vaultData.lock };
}

/**
 * Tạo object Lock mới để chiếm quyền phiên
 * @param {string} holderName Tên máy hoặc định danh thiết bị
 * @param {number} [ttlMs=300000] Thời gian thuê khóa (mặc định 5 phút)
 * @returns {object}
 */
export function createSessionLockData(holderName, ttlMs = 300000) {
  const now = Date.now();
  return {
    active: true,
    holder: holderName,
    locked_at: new Date(now).toISOString(),
    expires_at: new Date(now + ttlMs).toISOString(),
  };
}

/**
 * Tạo object giải phóng lock khi người dùng xong việc (swep down)
 * @returns {object}
 */
export function createReleaseLockData() {
  return {
    active: false,
    released_at: new Date().toISOString(),
  };
}

