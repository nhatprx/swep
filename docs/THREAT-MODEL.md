# Swep - Mô hình Đe dọa (Threat Model)

## Bảng Đánh Giá Rủi ro

| # | Kịch bản | Mức độ | Biện pháp | Trạng thái |
|---|---|---|---|---|
| T1 | Người lạ đoán mã qua mạng | 🟡 Thấp | Rate limit + khóa tăng dần + so sánh thời gian hằng số | ✅ Kiểm soát |
| T2 | Lộ riêng database (chỉ auth_hash, stored_blob) | 🟡 Thấp | Thiếu PEPPER (không dò offline) + SERVER_KEY (không đọc) | ✅ Kiểm soát |
| T3 | Chiếm toàn bộ server (database + PEPPER + SERVER_KEY) | 🟠 Trung bình | Argon2id nặng, mã dài hơn (v2), tài khoản Google riêng | ⚠️ Chấp nhận có điều kiện |
| T4 | Lộ mã (nhìn trộm, ghi chú) | 🟠 Trung bình | Mã dùng một lần; người dùng hợp lệ đăng nhập trước sẽ phát hiện bất thường | ⚠️ Giảm thiểu |
| T5 | Máy mượn có keylogger/malware | 🔴 Cao | **Ngoài phạm vi v1**: không cứu được mật khẩu Google bị lộ | 🚫 Ngoài phạm vi |
| T6 | `install.ps1` hoặc `swep.exe` bị thay đổi | 🔴 Cao | Ghim tag/commit, checksum SHA256, ghim phiên bản phụ thuộc | ✅ Kiểm soát |
| T7 | Quên `down` hoặc máy sập: profile Chrome còn đăng nhập | 🟠 Trung bình | Báo cáo rõ, nhắc đăng xuất thiết bị Google, `swep down` chạy lại được | ⚠️ Giảm thiểu |
| T8 | Gate hoặc Vercel ngừng hoạt động | 🟠 Trung bình | Không đăng nhập được; v1 chấp nhận (không có offline mode) | ⚠️ Chấp nhận |
| T9 | Dùng nhầm tài khoản Google chính | 🟠 Trung bình | README, wizard đều cảnh báo; khuyến nghị tài khoản riêng | ✅ Kiểm soát |
| T10 | Google khóa tài khoản do "đăng nhập lạ" | 🟠 Trung bình | Sử dụng tài khoản riêng; cách khôi phục tài khoản Google ngoài Swep | ⚠️ Giảm thiểu |
| T11 | Replay attack: sử dụng lại session cũ | 🟡 Thấp | Session có timeout ngắn (~10 phút); AAD trong AEAD chống replay | ✅ Kiểm soát |
| T12 | Race condition lúc xoay mã: hai phiên song song confirm | 🟡 Thấp | Mã chờ của phiên sau ghi đè phiên trước; mã chính không đổi | ✅ Kiểm soát |

## Chi tiết Các Tấn công

### T1: Dò mã qua mạng

**Kịch bản:** Attacker gửi nhiều `{handle, auth_key}` sai để tìm đúng.

**Phòng thủ:**
- 30 bit entropy = 2³⁰ ≈ 1 tỷ khả năng
- **Per-handle rate limit:** 5 lần sai → khóa 1 phút; 10 lần sai → khóa 10 phút; tăng lũy thừa
- **Per-IP rate limit:** 50 lần sai/phút → khóa IP 1 giờ
- **Phản hồi giống nhau:** mọi lỗi (handle không tồn tại, mã sai, tài khoản khóa) trả cùng status, cùng độ trễ
- **So sánh thời gian hằng số:** `crypto.timingSafeEqual()`

**Kết luận:** ✅ An toàn; tấn công toàn bộ 2³⁰ mã cần hàng năm, nếu bao quanh rate limit.

### T2: Lộ DB riêng

**Kịch bản:** Attacker lấy được database (auth_hash, stored_blob) nhưng không có PEPPER, SERVER_KEY.

**Phòng thủ:**
- `auth_hash` là HMAC với PEPPER → không thể tính từ `auth_key` mà attacker submit
- `stored_blob` được bọc bằng SERVER_KEY → không đọc được nội dung

**Kết luận:** ✅ An toàn; database riêng không dùng được.

### T3: Chiếm toàn bộ server

**Kịch bản:** Attacker có database + PEPPER + SERVER_KEY.

**Phòng thủ:**
- Có thể giải mã `stored_blob` → lấy được `wrap_code` và `payload`
- Nhưng vẫn cần dò offline để tìm `code_key` từ `wrap_code`
- Chi phí: 2³⁰ × Argon2id(3 vòng, 64MiB) = **hàng ngày**
- **Tùy chọn tương lai:** mã 8 ký tự (40 bit) = 2⁴⁰ = **hàng năm**

**Rủi ro được chấp nhận ở v1 vì:**
- Kẻ chiếm toàn bộ Vercel rất hiếm
- Argon2id nặng làm tăng chi phí đáng kể
- Người dùng sử dụng tài khoản Google riêng → nếu lộ thì không ảnh hưởng tài khoản chính

**Mitigations:**
- Backup PEPPER/SERVER_KEY ở KMS riêng (AWS KMS, Azure Key Vault)
- Giám sát logs bất thường
- Runbook khôi phục khi bị chiếm
- Cảnh báo người dùng khôi phục mã

### T4: Lộ mã

**Kịch bản:** Mã nhìn trộm hoặc ghi trong ghi chú không bảo mật.

**Phòng thủ:**
- Mã **dùng một lần**: lần đăng nhập sau sinh mã mới
- Người dùng hợp lệ đăng nhập trước người lạy → mã cũ được hủy, nhân viên nhận ra bất thường
- `swep revoke`: xóa mọi mã hiện tại + bắt buộc khôi phục

**Giảm thiểu:** nhắc người dùng xóa ghi chú, không chia sẻ mã.

### T5: Máy có malware

**Kịch bản:** Máy mượn bị cài keylogger/spyware trước khi dùng Swep.

**Phòng thủ:** **Không có** (không cứu được bất kỳ tool nào).

**Ngoài phạm vi v1:** phải xem như máy không an toàn, khuyến nghị:
- Sử dụng tài khoản Google riêng cho công việc
- Bật cảnh báo đăng nhập của Google
- Đổi mật khẩu ngay sau khi dùng xong trên máy lạ

### T6: Script/binary bị thay

**Kịch bản:** `install.ps1` hoặc `swep` binary bị attacker thay thế.

**Phòng thủ:**
- Tag cố định: `https://github.com/nhatprx/swep/releases/v0.1.0/swep`
- Checksum SHA256 trong script: **kiểm tra bắt buộc**
- Ghim phiên bản dependencies
- Build tái lập (reproducible build)
- Ký chương trình (nếu có budget)

**Mitigations:**
- Rà soát code trước mỗi release
- CI kiểm tra gitleaks (không có bí mật)
- Pin version Node.js ở CI

### T7: Profile Chrome còn đăng nhập

**Kịch bản:** Máy sập hoặc người dùng quên `swep down` → profile Chrome còn lại.

**Phòng thủ:**
- `swep down` in báo cáo so sánh snapshot trước/sau
- Nhắc rõ: **phải đăng xuất thiết bị tại myaccount.google.com/device-activity**
- `swep down` có thể chạy lại trên cùng máy

**Giảm thiểu:**
- Snapshot tự động khi `up` để dễ so sánh lúc `down`
- Tutorial làm sạch manual nếu Swep bị crash

### T8: Service ngừng hoạt động

**Kịch bản:** Vercel hoặc Postgres down → không đăng nhập được.

**Phòng thủ:** Không có (v1 chấp nhận dependency trên service).

**Tương lai (v2+):** offline mode hoặc service dự phòng.

### T9: Dùng tài khoản Google chính

**Kịch bản:** Người dùng dùng tài khoản Google chính (cá nhân/công ty) thay vì tài khoản riêng.

**Phòng thủ:**
- **README** cảnh báo lớn
- **Wizard đăng ký** yêu cầu xác nhận là tài khoản "riêng cho công việc"
- **`swep doctor`** kiểm tra xem có dùng tài khoản Google nào khác đã không

### T10: Google khóa tài khoản

**Kịch bản:** Google phát hiện đăng nhập từ máy lạ, yêu cầu xác minh thêm hoặc khóa tài khoản.

**Phòng thủ:**
- Sử dụng tài khoản riêng (ít khả năng bị lock vì lịch sử đăng nhập ít)
- Cảnh báo trong README: nếu bị khóa, khôi phục tại https://accounts.google.com

**Giảm thiểu:** tuỳ chọn recovery email khác.

### T11: Replay session

**Kịch bản:** Attacker ghi lại session token từ phiên đăng nhập cũ và dùng lại.

**Phòng thủ:**
- Session có timeout ngắn (~10 phút)
- AAD trong AEAD: `handle + version` → nếu version không khớp, giải mã thất bại
- Session bị xóa sau `confirm`

### T12: Race condition xoay mã

**Kịch bản:** Hai phiên đăng nhập gần đó cùng lúc xoay mã.

**Phòng thủ:**
- `POST /rotate/stage`: lưu `auth_hash'` ở trạng thái chờ
- Phiên mới ghi đè phiên cũ **ở trạng thái chờ**, không ảnh hưởng mã chính
- Mã chính chỉ thay đổi lúc `confirm` → **atomicity**: một phiên win

---

## Quy trình Ứng phó Sự cố

### Lộ PEPPER hoặc SERVER_KEY

1. **Khẩn cấp:** rotate cả hai bí mật ngay lập tức
2. **Giải mã:** giải mã toàn bộ `stored_blob` bằng bí mật cũ, tìm xem có gì lạ
3. **Thông báo:** nếu nghi ngờ có lộ mã người dùng, gửi thông báo (**không công khai chi tiết**)
4. **Cách khôi phục:** người dùng chạy `swep revoke` + `swep recover` để cấp mã mới
5. **Rà soát:** audit log kiểm tra truy cập bất thường
6. **Post-mortem:** chốt nguyên nhân, cập nhật runbook

### Mất Database

1. **Restore:** phục hồi từ backup gần nhất
2. **Xác định khoảng thời gian:** biết được từ khi nào đã mất
3. **Thông báo:** nếu phải, thông báo người dùng (nhưng DB không chứa cá nhân thực)
4. **Cách khôi phục:** người dùng chạy `swep recover` lại (GitHub + recovery_key)

### Hack GitHub account

1. Attacker không thể giả mạo device flow (cần xác thực thật trên GitHub)
2. Chỉ trong giai đoạn đăng ký/khôi phục, attacker có thể chiếm mã nếu chiếm cả GitHub + có recovery_key
3. **Phòng thủ:** bật 2FA trên GitHub, monitor login attempts

---

## Checklist Bảo mật (Giai đoạn 6)

- [ ] Rà soát CRYPTO.md độc lập
- [ ] Test tấn công: dò mã, timing, replay, race condition
- [ ] Quét dependencies: `npm audit`, `snyk`
- [ ] Quét bí mật: `gitleaks` trên mọi commit
- [ ] Ghim phiên bản: `npm ci` thay cho `npm install`
- [ ] Test khôi phục: backup/restore database
- [ ] Runbook: lộ bí mật, mất DB, hack GitHub
- [ ] Hoàn thiện SECURITY.md: cách báo lỗ hổng

