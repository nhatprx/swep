/**
 * Swep Gate Client SDK
 * Giao tiếp với Swep Gate backend (Vercel Functions + Postgres)
 */

import axios from 'axios';

const DEFAULT_GATE_URL = process.env.SWEP_GATE_URL || 'http://localhost:3000';

export class GateClient {
  constructor(baseUrl = DEFAULT_GATE_URL) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.client = axios.create({
      baseURL: this.baseUrl,
      timeout: 15000,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'swep-cli/0.1.0',
      },
    });
  }

  /**
   * Đăng ký tài khoản
   */
  async register(params) {
    const { github_token, handle, google_email, auth_hash, wrap_code, wrap_recovery, payload } = params;
    try {
      const res = await this.client.post('/api/register', {
        github_token,
        handle,
        google_email,
        auth_hash,
        wrap_code,
        wrap_recovery,
        payload,
      });
      return res.data;
    } catch (err) {
      this._handleError(err);
    }
  }

  /**
   * Đăng nhập bằng handle và auth_key
   */
  async login(handle, authKeyHex) {
    try {
      const res = await this.client.post('/api/login', {
        handle,
        auth_key: authKeyHex,
      });
      return res.data;
    } catch (err) {
      this._handleError(err);
    }
  }

  /**
   * Lưu mã mới ở trạng thái chờ (staging)
   */
  async rotateStage(session, newAuthHash, newWrapCode) {
    try {
      const res = await this.client.post('/api/rotate/stage', {
        session,
        auth_hash: newAuthHash,
        wrap_code: newWrapCode,
      });
      return res.data;
    } catch (err) {
      this._handleError(err);
    }
  }

  /**
   * Xác nhận mã mới đã lưu và kích hoạt chính thức
   */
  async rotateConfirm(session) {
    try {
      const res = await this.client.post('/api/rotate/confirm', {
        session,
      });
      return res.data;
    } catch (err) {
      this._handleError(err);
    }
  }

  /**
   * Cập nhật payload sau khi dùng mã dự phòng
   */
  async updatePayload(session, newPayload) {
    try {
      const res = await this.client.post('/api/payload', {
        session,
        payload: newPayload,
      });
      return res.data;
    } catch (err) {
      this._handleError(err);
    }
  }

  /**
   * Khôi phục khi mất mã
   */
  async recover(githubToken, handle, recoveryAuth) {
    try {
      const res = await this.client.post('/api/recover', {
        github_token: githubToken,
        handle,
        recovery_auth: recoveryAuth,
      });
      return res.data;
    } catch (err) {
      this._handleError(err);
    }
  }

  /**
   * Hoàn tất khôi phục với mã mới
   */
  async recoverFinish(params) {
    try {
      const res = await this.client.post('/api/recover/finish', params);
      return res.data;
    } catch (err) {
      this._handleError(err);
    }
  }

  /**
   * Thu hồi mọi mã (Kill switch)
   */
  async revoke(githubToken) {
    try {
      const res = await this.client.post('/api/revoke', {
        github_token: githubToken,
      });
      return res.data;
    } catch (err) {
      this._handleError(err);
    }
  }

  /**
   * Health check kết nối đến Gate
   */
  async healthCheck() {
    try {
      const res = await this.client.get('/api/health');
      return res.data?.status === 'ok';
    } catch {
      return false;
    }
  }

  _handleError(err) {
    if (err.response) {
      const { status, data } = err.response;
      const msg = data?.message || data?.error || `HTTP ${status}`;
      const e = new Error(msg);
      e.status = status;
      e.code = data?.status || data?.code;
      throw e;
    }
    throw new Error(`Không thể kết nối đến Swep Gate (${this.baseUrl}): ${err.message}`);
  }
}

export const defaultGate = new GateClient();
