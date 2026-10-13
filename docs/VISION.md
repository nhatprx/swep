# Swep - Tầm nhìn dài hạn

Sau khi v1 ổn định, Swep mở rộng thành bộ dựng môi trường làm việc đầy đủ.

## Các module tương lai

### Docker/WSL2
- Distro riêng `devbox` chạy Docker Engine (không cần Docker Desktop)
- Dọn bằng `wsl --unregister devbox`

### Database
- `docker compose` với profiles: Postgres, MySQL, Redis, Mongo, SQL Server
- Menu chọn khi setup

### IDE
- Cài Cursor, áp `settings.json`, `keybindings.json`
- Danh sách extension (Excalidraw, Markdown Preview Enhanced...)
- Chạy với `--user-data-dir` và `--extensions-dir` trong thư mục gốc (dọn một lần)

### Project Runner
- Chọn repo hoặc thư mục, tự clone
- Nhận diện loại project: `package.json`, `docker-compose.yml`, `requirements.txt`, `pom.xml`...
- Chạy lệnh, **luôn hỏi xác nhận trước khi thực thi**

### Port Dashboard
- Hiển thị mapping: `5173 → FE`, `8080 → BE`, các port database

### File Transfer
- Truyền file giữa các máy

### Enhanced Ledger
- Ghi đầy đủ mọi thay đổi hệ thống
- Windows features, app đã cài, tác vụ định kỳ
- Mỗi mục có cờ `preexisting` từ snapshot

### Repo Profile (Private)
- Markdown files với YAML front matter
- Máy đọc YAML, người đọc văn xuôi

---

Chi tiết thiết kế sẽ được cập nhật khi bắt đầu.
