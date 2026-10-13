# ⚡ Swep (v0.1.0)

> **Môi trường làm việc tạm thời & Profile Chrome cô lập.**  
> Một lệnh để bắt đầu → Chrome đã đăng nhập Google → Xong việc → Tự hủy sạch 100%, không còn dấu vết.

[![Version](https://img.shields.io/badge/version-0.1.0-blue.svg)](https://github.com/nhatprx/swep)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18.0.0-green.svg)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

---

## 🚀 Cài đặt nhanh (1 dòng lệnh duy nhất)

Mở **PowerShell** trên bất kỳ máy Windows nào và chạy:

```powershell
irm https://raw.githubusercontent.com/nhatprx/swep/main/install.ps1 | iex
```

*Installer sẽ tự động thiết lập Node.js (nếu chưa có), tải Swep về `%LOCALAPPDATA%\Swep` và đăng ký lệnh `swep` vào PATH.*

---

## 📖 Hướng dẫn sử dụng

### 1. Đăng ký lần đầu (trên thiết bị tin cậy của bạn)

```powershell
swep register
```
- Kết nối GitHub PAT (lưu trữ vault) & tài khoản Google công việc.
- Hệ thống tạo mã đăng nhập ngẫu nhiên (ví dụ: `nhatprx-YAS6-EAA0-5M`) và **Khóa khôi phục** (Recovery Key).
- Dữ liệu được mã hóa Zero-Knowledge ngay tại máy trước khi lưu lên repo `swep-vault`.

### 2. Sử dụng trên máy làm việc / máy mượn

```powershell
swep <mã-đăng-nhập>
```
- Tải vault và giải mã Profile Capsule từ GitHub.
- Khởi động Google Chrome với profile cô lập hoàn toàn, session và cookies đã sẵn sàng.
- Terminal được giải phóng ngay lập tức để bạn tiếp tục gõ lệnh khác.

### 3. Mở lại Chrome nếu lỡ tay tắt

```powershell
swep chrome
```
*(Hoặc `swep open`)* — Mở lại cửa sổ Chrome cô lập của phiên hiện tại mà không ảnh hưởng đến Chrome chính của máy.

### 4. Xong việc & Tự hủy sạch sẽ 100%

```powershell
swep exit
```
*(Hoặc `swep down`)*:
1. Đóng Chrome an toàn, flush toàn bộ dữ liệu SQLite/LevelDB.
2. Nén & mã hóa **Profile Capsule** (cookies, tokens, local storage) đẩy lên GitHub Releases.
3. Gỡ sạch `swep` khỏi User PATH trong Registry.
4. Xóa ngay file lệnh thực thi và tự hủy toàn bộ thư mục `%LOCALAPPDATA%\Swep`.
5. In đúng **1 dòng duy nhất**:
   ```text
   ✔ Đã sao lưu dữ liệu lên GitHub và xóa sạch hoàn toàn Swep trên máy tính.
   ```

---

## 📋 Danh sách câu lệnh (CLI Cheatsheet)

| Lệnh | Phím tắt / Alias | Mô tả chức năng |
|---|---|---|
| `swep [mã]` | `swep up`, `swep login` | Đăng nhập và mở Chrome với profile tạm thời (mặc định) |
| `swep chrome` | `swep open` | Mở lại cửa sổ Chrome của Swep khi đang trong phiên |
| `swep exit` | `swep down` | Sao lưu session lên GitHub và **xóa sạch 100% Swep khỏi máy** |
| `swep register` | — | Đăng ký tài khoản lần đầu (Zero-Knowledge vault) |
| `swep -v` | `swep --version` | Kiểm tra phiên bản Swep hiện tại (`0.1.0`) |
| `swep doctor` | — | Kiểm tra điều kiện máy (Chrome, Node, Registry, Network) |
| `swep recover` | — | Khôi phục quyền truy cập khi mất mã bằng Khóa khôi phục |
| `swep revoke` | — | Kill switch: vô hiệu hóa toàn bộ mã truy cập trên vault |

---

## 🔒 Bảo mật Zero-Knowledge

- **Mã hóa client-side**: Dữ liệu được mã hóa bằng **AEAD ChaCha20-Poly1305** kết hợp hàm dẫn xuất khóa **Argon2id**.
- **Không máy chủ trung gian**: Tương tác trực tiếp giữa client Swep và GitHub của bạn. Không ai (kể cả GitHub) đọc được mật khẩu hay cookies nếu không có mã truy cập.
- **Profile Capsule V2**: Lưu trữ thông minh session, SQLite WAL checkpoints và LevelDB tokens, giúp phiên đăng nhập Google duy trì liên tục và an toàn mà không bị Google gắn cờ máy lạ.

---

## 📄 License

Phát hành dưới giấy phép [MIT License](LICENSE).
