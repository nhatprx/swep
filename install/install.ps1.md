# Swep - Bootstrap script

**Cách dùng:**
```powershell
irm https://raw.githubusercontent.com/<owner>/swep/<tag>/install.ps1 | iex
```

Script này sẽ:
1. Kiểm tra Node.js, cài nếu chưa có
2. Cài package `swep` từ NPM
3. Chạy `swep` lần đầu

## Tiêu chí an toàn

- ✅ Ghim tag/commit cố định (không dùng `latest`)
- ✅ Checksum SHA256 cho từng phiên bản (kiểm tra bắt buộc)
- ✅ Rà soát code trước khi phát hành
- ✅ Không cài dependency không cần thiết
