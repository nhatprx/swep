# Swep - Mô hình Đe dọa (Threat Model) - Phiên bản Zero-Server

> **Định vị & Phạm vi sử dụng:**
> Swep là công cụ ánh xạ môi trường làm việc và phiên duyệt web di động (**Portable Workspace Sessions for Multi-Device Developers**), được thiết kế cho các nhà phát triển và kỹ sư di chuyển thường xuyên giữa các máy tính (máy công ty, laptop cá nhân, máy phụ). Swep giảm thiểu tối đa rủi ro phơi nhiễm Master Password của tài khoản Google/GitHub và tự động dọn dẹp dấu vết phiên tạm sau khi hoàn tất công việc.

---

## 1. Ma trận Đánh giá Rủi ro Thực tế

| # | Kịch bản Đe dọa | Mức độ | Biện pháp Phòng vệ | Đánh giá & Rủi ro còn lại |
|---|---|---|---|---|
| **T1** | Kẻ xấu đoán mã đăng nhập qua mạng | 🟡 Thấp | 10 ký tự Base32 (~50 bit entropy) + Argon2id (64MB RAM, 3 vòng) | Khó khả thi trong thực tế do chi phí tính toán KDF cực lớn và GitHub API Rate Limit. |
| **T2** | Lộ link Secret Gist (URL bị rò rỉ) | 🟠 Trung bình | Ciphertext mã hóa AEAD (XSalsa20-Poly1305) bọc bởi khóa DEK 256-bit | Ai có link đọc được ciphertext, nhưng không thể giải mã nếu không có mã login code. |
| **T3** | Dùng mã cũ mở lại dữ liệu qua Gist Revision | 🟡 Thấp | **True Re-Keying:** Mỗi lần xoay mã, sinh DEK 256-bit mới toanh và mã hóa lại toàn bộ capsule | Mã cũ và commit cũ trên Gist không thể dùng để giải mã capsule của phiên mới. |
| **T4** | Khác biệt Windows DPAPI / App-Bound Encryption | 🟡 Thấp | **CDP WebSocket Pipeline:** Trích xuất và bơm plaintext cookies trực tiếp qua `Storage.getCookies` & `Storage.setCookies` | Chrome máy đích tự nhận cookie và tự mã hóa lại bằng DPAPI cục bộ; không phụ thuộc khóa máy cũ. |
| **T5** | Máy đích bị nhiễm Keylogger/Malware cấp OS | 🔴 Cao | Chỉ phơi nhiễm mã dùng 1 lần của phiên hiện tại, **không phơi nhiễm Master Password hay OTP gốc** | Giảm thiểu tối đa bề mặt tấn công tài khoản gốc. Tuy nhiên nếu mã bị bắt kịp lúc, phiên tạm có thể bị dùng trước khi người dùng kịp thoát. |
| **T6** | Khôi phục dữ liệu còn sót lại trên ổ SSD | 🟠 Trung bình | Fast single-pass random overwrite + truncate về 0 byte + unlink file (NIST SP 800-88 Clear) | Hiện đạt cấp NIST Clear; cấp Purge (crypto-erase/RAM disk) là hướng nâng cấp tương lai cho máy dùng SSD. Tốt hơn xóa thông thường, nhưng do cơ chế wear-leveling của chip flash, không đảm bảo tuyệt đối 100% vật lý nếu không dùng disk-level crypto. |
| **T7** | Lỗi mạng / Rate Limit khi đồng bộ ngược lên Gist | 🟡 Thấp | **Push Failure Protection:** Giữ nguyên phiên local và mã cũ, ngừng xóa workspace nếu push thất bại | Người dùng không bị mất quyền truy cập hoặc mất dữ liệu giữa chừng. |

---

## 2. Phân tích Chi tiết & Đánh đổi Kiến trúc (Trade-offs)

### 2.1. Đánh đổi về Keylogger & Infostealer
* **Lợi thế của Swep:** Thay vì gõ Master Password của tài khoản Google kèm mã 2FA trên máy mới $N$ lần, bạn chỉ gõ mã Swep ngắn hạn (~50 bit, xoay vòng sau mỗi phiên). Bề mặt phơi nhiễm thông tin đăng nhập gốc giảm từ $N$ lần về $1$ lần duy nhất lúc đăng ký trên máy tin cậy.
* **Đánh đổi:** Vì Swep phục hồi phiên làm việc bằng session cookies hợp lệ, Google thường xem đây là phiên tiếp diễn và không kích hoạt cảnh báo đăng nhập lạ từ thiết bị mới. Nếu kẻ tấn công bắt được mã đăng nhập và sử dụng trước khi bạn kích hoạt phiên, họ có thể vào được phiên tạm mà không bị Google Prompt chặn lại.

### 2.2. Điểm lưu ý về Bảo mật Gist (Secret Gist vs Private ACL)
* Secret Gist trên GitHub là dạng **unlisted** (ẩn khỏi danh sách công khai, nhưng bất kỳ ai có URL đều có thể đọc nội dung JSON mà không cần đăng nhập).
* Swep bù đắp điều này bằng mật mã học tầng ứng dụng: Dữ liệu bên trong luôn là Ciphertext được mã hóa bởi khóa dẫn xuất từ Argon2id. Tuy nhiên, trong tương lai có thể cân nhắc chuyển sang GitHub Private Repository có OAuth ACL chặt chẽ hơn.

### 2.3. Vòng đời GitHub Token trên Thiết bị
* Để thực hiện cơ chế xoay mã và đồng bộ dữ liệu phiên ngược lên Gist khi kết thúc (`swep down`), Swep cần quyền ghi Gist. Token này được lưu trong file `active-session.json` được bảo vệ cục bộ và bị xóa sạch ngay khi phiên kết thúc.
* Token được cấp quyền chỉ giới hạn tối thiểu ở scope `gist`, không có quyền can thiệp vào repo mã nguồn, email hay SSH key của người dùng.

---

## 3. Backlog An ninh cho các Phiên bản Tương lai
1. **Kiểm soát truy cập chặt hơn cho Vault Storage:** Nghiên cứu hỗ trợ Private Repo với Fine-Grained Personal Access Token thay vì Secret Gist unlisted.
2. **Ephemeral RAM Disk (In-Memory Workspace):** Khởi chạy thư mục profile tạm thời trực tiếp trên RAM disk (khi OS hỗ trợ) để loại bỏ 100% dấu vết vật lý trên chip nhớ SSD flash.
3. **QR Code Handshake:** Cho phép truyền mã phiên trực tiếp từ điện thoại sang máy tính qua kết nối cục bộ hoặc camera để giảm thiểu hoàn toàn việc gõ phím vật lý.
