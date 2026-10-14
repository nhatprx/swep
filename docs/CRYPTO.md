# Swep - Kiến trúc mã hóa

> **Phần này cần nhất sự cẩn thận.** Chỉ ghép các primitive chuẩn, không tự nghĩ ra thuật toán.

## Mã đăng nhập

- **Dạng:** `<handle>-XXX-XXX`
  - `handle` = username GitHub (chữ thường, cố định từ lúc đăng ký)
  - 6 ký tự lấy từ bảng Crockford base32 (không có I, L, O, U) = **30 bit entropy**
- **Chuẩn hóa:** bỏ gạch ngang, không phân biệt hoa/thường, `O→0`, `I/L→1`

### Ví dụ

```
nhatprx-7K2-QX9
│      │ │ │ │
handle │ │ │ └─ ký tự 4-6 (15 bit)
       │ │ └─── ký tự 1-3 (15 bit)
       └─────── cách ngăn
```

## Dẫn xuất khóa (Client)

```
code      = 6 ký tự người dùng nhập
seed      = Argon2id(
              password=code,
              salt=SHA256("swep/v1/" + handle),
              t_cost=3,
              m_cost=65536 (64 MiB),
              parallelism=4,
              type=id
            )
auth_key  = HKDF(seed, info="swep/auth")      # 32 byte, gửi lên server
code_key  = HKDF(seed, info="swep/wrap")      # 32 byte, KHÔNG rời máy
```

### Tham số Argon2id

Mục tiêu: **0.5–1 giây** trên máy yếu (để test spike C).

- `t_cost = 3`: 3 vòng lặp
- `m_cost = 65536`: 64 MiB RAM
- `parallelism = 4`: 4 thread
- `type = argon2id`: chống cả tấn công side-channel và GPU

**Lý do:** với 30 bit entropy, nếu attacker có toàn bộ server (database + bí mật), họ có thể thử offline ≈ 2³⁰ × chi phí argon2. Argon2id nặng làm tăng chi phí từ microsecond lên hàng giây/mã, vô hiệu hóa tấn công này trong hạn hợp lý.

## Gói dữ liệu (Payload)

```
DEK               = 32 byte ngẫu nhiên, sinh một lần lúc đăng ký
payload           = Plaintext:
                    {
                      google_email: "...",
                      google_password: "...",
                      totp_secret: "...",        # base32
                      backup_codes: [...],        # sau khi dùng một cái
                      version: 1
                    }

wrap_code         = AEAD(code_key, DEK)         # bọc DEK bằng mã hiện tại
wrap_recovery     = AEAD(recovery_key, DEK)     # bọc DEK bằng khóa khôi phục
```

### Lợi ích DEK

1. **Xoay mã nhanh:** chỉ bọc lại DEK (32 byte), không mã hóa lại payload
2. **Khôi phục độc lập:** `wrap_recovery` không phụ thuộc vào `wrap_code`

### AEAD

- **Cipher:** XSalsa20-Poly1305 (TweetNaCl secretbox)
  - Nonce: 192-bit ngẫu nhiên (24 bytes) từ CSPRNG
  - AAD (Associated Authenticated Data): `handle + version` (ví dụ: `"nhatprx/1"`)
- **Lý do AAD:** chống replay khi xoay mã (mã mới không thể giải mã cũ, và ngược lại)

## Phía Server (Phòng thủ chiều sâu)

```
auth_hash        = HMAC-SHA256(PEPPER, auth_key)     # lưu trong DB
stored_blob      = AEAD(SERVER_KEY, {
                         payload ‖ wrap_code ‖ wrap_recovery
                       })                              # bọc thêm lớp
```

### Bí mật Server

- `PEPPER`: biến môi trường Vercel, **không lưu DB**
  - Dùng để tính `auth_hash` (so khớp lúc đăng nhập)
  - Kẻ chỉ có DB không thể tính `auth_hash` từ `auth_key` mà attacker submit
- `SERVER_KEY`: biến môi trường Vercel, **không lưu DB**
  - Dùng để mã hóa/giải mã `stored_blob`
  - Kẻ chỉ có DB không thể mở được blob

### Tấn công và Phòng thủ

| Tấn công | Điều kiện | Kết quả | Biện pháp |
|---|---|---|---|
| Dò mã qua mạng | Attacker gửi nhiều `{handle, auth_key}` sai | Rate limit + khóa tăng dần | ✅ Toàn bộ DB, mọi handle |
| Lộ riêng DB | Attacker có `auth_hash`, `stored_blob` nhưng không có `PEPPER`, `SERVER_KEY` | Không dò được offline, không mở được blob | ✅ DB bị lộ riêng |
| Chiếm toàn bộ | Attacker có `auth_hash`, `stored_blob`, `PEPPER`, `SERVER_KEY` | Có thể dò từng `auth_key` offline (2³⁰ lần × argon2 = hàng giờ) | ⚠️ **Rủi ro được chấp nhận ở v1** |

**Mitigations cho T3:**
- Argon2id nặng (t_cost=3, m_cost=64MiB)
- Tùy chọn tăng độ dài mã từ 6 → 8 ký tự (30 → 40 bit)
- Người dùng sử dụng tài khoản Google riêng (không làm lộ tài khoản chính)
- Kill switch: `swep revoke` vô hiệu mọi mã cũ, bắt buộc khôi phục

## Recovery Key

```
recovery_key     = 128 bit ngẫu nhiên, hiển thị một lần
                 = định dạng nhóm 4 ký tự (ví dụ: 4F8Q-2P9K-L7R3-M5X8)
wrap_recovery    = AEAD(recovery_key, DEK)
recovery_auth    = HMAC-SHA256(recovery_key)         # lưu DB, so khớp
```

**Quy tắc:**
- Hiển thị **một lần** lúc đăng ký
- Người dùng lưu ở nơi an toàn (khác thiết bị)
- Dùng để `swep recover` khi mất mã chính

## So sánh Thời gian Hằng số (Timing-Safe Comparison)

Lúc so khớp `auth_hash` hoặc xác thực, **luôn dùng hàm so sánh thời gian hằng số** để chống tấn công timing:

```javascript
// ✅ Đúng
const crypto = require('crypto');
const result = crypto.timingSafeEqual(userHash, computedHash);

// ❌ Sai (dễ tấn công timing)
const result = userHash === computedHash;
```

## Việc Cấm

- ❌ Tự cài đặt thuật toán mã hóa
- ❌ Ghi mã, khóa, mật khẩu ra đĩa hay log
- ❌ Dùng chung khóa giữa các mục đích (phải tách bằng HKDF `info`)
- ❌ Gửi `code_key` lên server
- ❌ Gửi `PEPPER` hoặc `SERVER_KEY` vào code repo

## Test Vector (RFC 6238 TOTP)

```
Secret: JBSWY3DPEBLW64TMMQ (base32)
Time:   1234567890 (seconds)
TOTP:   050471   (6 digits)
```

---

**Thay đổi bất kỳ phần nào ở mục `crypto/` hoặc `gate/lib/` phải được review kỹ lưỡng.**
