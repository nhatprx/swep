# Swep - Giao thức API & Dữ liệu (Specification)

## Endpoints

### 1. `POST /api/register`

**Xác thực:** Token GitHub (device flow)

**Request:**
```json
{
  "github_token": "gho_...",
  "handle": "nhatprx",
  "google_email": "nhatprx@gmail.com",
  "auth_hash": "hmac-sha256(...)",
  "wrap_code": {
    "nonce": "...",
    "ciphertext": "...",
    "tag": "..."
  },
  "wrap_recovery": {
    "nonce": "...",
    "ciphertext": "...",
    "tag": "..."
  },
  "payload": {
    "nonce": "...",
    "ciphertext": "...",
    "tag": "..."
  }
}
```

**Response (200):**
```json
{
  "status": "ok",
  "github_id": 12345,
  "handle": "nhatprx",
  "created_at": "2026-10-13T10:00:00Z"
}
```

**Errors:**
- `409`: handle đã tồn tại
- `401`: token GitHub không hợp lệ hoặc handle ≠ github.login

---

### 2. `POST /api/login`

**Xác thực:** `handle` + `auth_key`

**Request:**
```json
{
  "handle": "nhatprx",
  "auth_key": "..."  // dùng để tính auth_hash
}
```

**Response (200):**
```json
{
  "status": "ok",
  "session": "sess_...",
  "payload": {
    "nonce": "...",
    "ciphertext": "...",
    "tag": "..."
  },
  "wrap_code": {
    "nonce": "...",
    "ciphertext": "...",
    "tag": "..."
  },
  "notices": {
    "failed_count": 0,
    "last_login_at": "2026-10-13T09:30:00Z"
  }
}
```

**Errors:**
- `401`: handle hoặc auth_key sai
- `429`: quá nhiều lần thử sai → khóa tạm thời
- `410`: tài khoản bị revoke

**Phòng thủ:**
- Giới hạn per-handle: 5 sai/phút → khóa 1 phút; 10 sai/giờ → khóa 1 giờ
- Giới hạn per-IP: 50 sai/phút → khóa IP 1 giờ
- **So sánh thời gian hằng số** (timing-safe)
- **Phản hồi giống nhau** cho "handle không tồn tại" vs "mã sai"

---

### 3. `POST /api/rotate/stage`

**Xác thực:** `session` (từ login)

**Request:**
```json
{
  "session": "sess_...",
  "auth_hash": "...",     // auth_hash mới
  "wrap_code": {          // wrap_code mới
    "nonce": "...",
    "ciphertext": "...",
    "tag": "..."
  }
}
```

**Response (200):**
```json
{
  "status": "ok",
  "message": "Mã chờ đã lưu. Vui lòng nhập lại để xác nhận."
}
```

**Behavior:**
- Lưu `auth_hash`, `wrap_code` ở trạng thái chờ (`pending_*`)
- Mã cũ vẫn hoạt động
- Phiên mới ghi đè phiên cũ ở trạng thái chờ
- Tự hết hạn sau 15 phút nếu không `confirm`

---

### 4. `POST /api/rotate/confirm`

**Xác thực:** `session`

**Request:**
```json
{
  "session": "sess_..."
}
```

**Response (200):**
```json
{
  "status": "ok",
  "message": "Mã đã được xác nhận. Mã cũ hết hiệu lực."
}
```

**Behavior:**
- Thăng cấp `pending_auth_hash`, `pending_wrap_code` thành chính thức
- Xóa mã cũ
- Đánh dấu session là `used_for_confirm = true` (không dùng lại)
- **Idempotent:** gọi lại cùng session cho kết quả như nhau

---

### 5. `POST /api/payload`

**Xác thực:** `session`

**Request:**
```json
{
  "session": "sess_...",
  "payload": {
    "nonce": "...",
    "ciphertext": "...",
    "tag": "..."
  }
}
```

**Response (200):**
```json
{
  "status": "ok"
}
```

**Mục đích:** cập nhật payload sau khi dùng một mã dự phòng Google.

---

### 6. `POST /api/recover`

**Xác thực:** Token GitHub (device flow) + `recovery_auth`

**Request:**
```json
{
  "github_token": "gho_...",
  "handle": "nhatprx",
  "recovery_auth": "..."  // HMAC của recovery_key
}
```

**Response (200):**
```json
{
  "status": "ok",
  "payload": {
    "nonce": "...",
    "ciphertext": "...",
    "tag": "..."
  },
  "wrap_recovery": {
    "nonce": "...",
    "ciphertext": "...",
    "tag": "..."
  }
}
```

**Behavior:**
- Client dùng `recovery_key` để giải mã `wrap_recovery` → lấy DEK
- Giải mã payload bằng DEK
- Chuẩn bị mã mới và sinh recovery_key mới

---

### 7. `POST /api/recover/finish`

**Xác thực:** Token GitHub + `recovery_auth`

**Request:**
```json
{
  "github_token": "gho_...",
  "handle": "nhatprx",
  "auth_hash": "...",     // auth_hash mới
  "wrap_code": {          // wrap_code mới
    "nonce": "...",
    "ciphertext": "...",
    "tag": "..."
  },
  "wrap_recovery": {      // recovery_key mới (optional)
    "nonce": "...",
    "ciphertext": "...",
    "tag": "..."
  },
  "payload": {
    "nonce": "...",
    "ciphertext": "...",
    "tag": "..."
  }
}
```

**Response (200):**
```json
{
  "status": "ok",
  "message": "Mã mới đã được đặt"
}
```

**Behavior:**
- Thay thế `auth_hash`, `wrap_code`, payload
- Thay thế `wrap_recovery` nếu có
- Vô hiệu hóa phiên khôi phục cũ

---

### 8. `POST /api/revoke`

**Xác thực:** Token GitHub

**Request:**
```json
{
  "github_token": "gho_..."
}
```

**Response (200):**
```json
{
  "status": "ok",
  "message": "Mọi mã đã bị vô hiệu hóa. Dùng `swep recover` để khôi phục."
}
```

**Behavior:**
- Đặt `revoked_at` = hiện tại
- Xóa `auth_hash`, `wrap_code`, `pending_*`
- Người dùng **phải** chạy `swep recover` để dùng lại

---

## Bảng Dữ liệu

### `users`

| Cột | Kiểu | Ghi chú |
|---|---|---|
| `github_id` | BIGINT, PK | ID GitHub, ổn định kể cả đổi username |
| `handle` | VARCHAR(32), UNIQUE | Username lúc đăng ký, dùng làm tiền tố mã |
| `created_at` | TIMESTAMP | |
| `auth_hash` | VARCHAR(64) | HMAC-SHA256(PEPPER, auth_key) |
| `wrap_code` | JSONB | `{ nonce, ciphertext, tag }` |
| `pending_auth_hash` | VARCHAR(64) | Mã chờ: tự hết hạn sau 15 phút |
| `pending_wrap_code` | JSONB | Mã chờ |
| `pending_at` | TIMESTAMP | Thời điểm bắt đầu chờ |
| `stored_blob` | TEXT | AEAD(SERVER_KEY, payload ‖ wrap_code ‖ wrap_recovery) |
| `recovery_auth_hash` | VARCHAR(64) | HMAC của recovery_key |
| `failed_count` | INT | Đếm lần sai kể từ last_failed_reset |
| `failed_since_last_login` | INT | Số lần sai sau lần đăng nhập trước |
| `locked_until` | TIMESTAMP | Null = không khóa |
| `last_login_at` | TIMESTAMP | |
| `revoked_at` | TIMESTAMP | Null = hoạt động |

### `sessions`

| Cột | Kiểu | Ghi chú |
|---|---|---|
| `id` | VARCHAR(64), PK | SHA256(random) |
| `github_id` | BIGINT, FK | |
| `created_at` | TIMESTAMP | |
| `expires_at` | TIMESTAMP | ~10 phút |
| `used_for_confirm` | BOOLEAN | Đánh dấu nếu dùng cho `/rotate/confirm` |

### `audit_log`

| Cột | Kiểu | Ghi chú |
|---|---|---|
| `id` | BIGINT, PK | Auto-increment |
| `timestamp` | TIMESTAMP | |
| `github_id` | BIGINT | Null nếu handle không tồn tại |
| `handle` | VARCHAR(32) | |
| `ip_hash` | VARCHAR(64) | SHA256(IP) |
| `action` | VARCHAR(32) | `login_ok`, `login_failed`, `rotate_stage`, `recover_start`, `revoke` |
| `details` | TEXT | JSON: `{ failed_count, reason }` |

**Quy tắc:** Không ghi mã, khóa, hoặc payload; chỉ ghi hành động và kết quả.

---

## Mã lỗi

| Code | Ý nghĩa | HTTP |
|---|---|---|
| `ok` | Thành công | 200 |
| `auth_failed` | Handle hoặc auth_key sai | 401 |
| `session_expired` | Session hết hạn | 401 |
| `account_locked` | Tài khoản bị khóa tạm | 429 |
| `account_revoked` | Tài khoản bị revoke | 410 |
| `rate_limited` | IP bị giới hạn | 429 |
| `invalid_request` | Dữ liệu không hợp lệ | 400 |
| `handle_exists` | Handle đã tồn tại | 409 |
| `github_auth_failed` | Token GitHub không hợp lệ | 401 |
| `server_error` | Lỗi máy chủ | 500 |

---

## Thời gian Timeout

| Thành phần | TTL | Ghi chú |
|---|---|---|
| Session | 10 phút | Cho đủ thời gian xoay mã và confirm |
| Pending mã | 15 phút | Lâu hơn session để người dùng kịp nhập lại |
| Khóa tần suất | Tăng lũy thừa | 1 phút → 5 phút → 30 phút → 2 giờ |

---

## Rate Limiting

### Per-handle

- **0–5 lần sai:** không khóa
- **5–10 lần/phút:** khóa 1 phút
- **10 lần/giờ:** khóa 10 phút
- **20 lần/ngày:** khóa 1 giờ
- Bộ đếm reset lúc đăng nhập thành công

### Per-IP

- **0–50 lần/phút:** không khóa
- **50–100 lần/phút:** khóa IP 10 phút
- **100+ lần/phút:** khóa IP 1 giờ
- Bộ đếm reset mỗi phút

### Phản hồi

```json
{
  "status": "rate_limited",
  "retry_after": 60,
  "message": "Quá nhiều lần thử. Vui lòng thử lại sau 60 giây."
}
```

---

## Deployment

**Hạ tầng:** Vercel Functions + Postgres

**Biến môi trường:**
- `PEPPER`: bí mật phải được rotate định kỳ (mặc định 90 ngày)
- `SERVER_KEY`: bí mật phải được rotate định kỳ
- `GITHUB_CLIENT_ID`: ID OAuth của Swep trên GitHub
- `DATABASE_URL`: kết nối Postgres

**Backup:** Database được backup tự động; kiểm tra restore 1 lần/tháng.

