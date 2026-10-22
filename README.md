# Trợ lý Cố vấn học tập – Trường Dược

Web app hỏi đáp quy chế cho **sinh viên** và **cố vấn học tập (CVHT)** của Trường Dược, ĐHYD TP.HCM.
Trợ lý AI trả lời dựa trên văn bản của trường, luôn ghi nguồn, kèm nút mở văn bản / mẫu đơn gốc.

```
Trình duyệt ──► Cloudflare Worker (cvht.truongduoc.workers.dev)
                  │  public/index.html  → giao diện
                  │  POST /api          → Google Apps Script (đăng nhập, tài liệu, câu hỏi SV)
                  │  POST /api/chat     → tìm Điều liên quan + Trợ lý AI (Workers AI miễn phí)
                  ▼
           Google Sheet + Apps Script (apps-script/Code.gs)
             NguoiDung · KienThuc · TaiLieu · NhapVanBan · LichSuHoi · NhatKy
```

## Chức năng

| Ai | Được làm gì |
|---|---|
| Sinh viên | Hỏi Trợ lý AI · xem tài liệu & mẫu đơn · xem CVHT phụ trách |
| CVHT | Như trên + xem **câu hỏi của sinh viên mình phụ trách** (kèm câu trả lời, đánh giá 👍/👎) |
| Quản trị | Như CVHT nhưng xem câu hỏi của toàn bộ sinh viên |

- Đăng nhập theo danh sách trong sheet `NguoiDung`. Lần đầu dùng mật khẩu mặc định (sinh viên: ngày sinh ddmmyyyy), sau đó **bắt buộc đổi**.
- Sai mật khẩu 10 lần → khóa 15 phút. Phiên đăng nhập 7 ngày.
- Mỗi sinh viên hỏi tối đa **20 câu/ngày**, CVHT/quản trị **60 câu/ngày** (đổi được, xem bên dưới).

## Triển khai

### 1. Google Sheet + Apps Script
1. Tạo một Google Sheet mới (nên dùng tài khoản của Trường Dược).
2. **Tiện ích mở rộng → Apps Script**, xóa mã mẫu, dán toàn bộ `apps-script/Code.gs`, bấm **Lưu**.
3. Chọn hàm **`caiDat`** → **▶ Chạy** → cấp quyền.
   Mở **Nhật ký thực thi**: có `PROXY_KEY` và mật khẩu tài khoản `admin`.
4. **Triển khai → Tùy chọn triển khai mới → Ứng dụng web**
   - Thực thi với tư cách: **Tôi**
   - Người có quyền truy cập: **Bất kỳ ai**
   Sao chép URL kết thúc bằng `/exec`.

### 2. GitHub
Tạo repo `td-ship-it/cvht`, tải lên toàn bộ nội dung thư mục này (`apps-script`, `public`, `src`, `wrangler.toml`, `README.md`).

### 3. Cloudflare
1. **Workers & Pages → Create → Import a repository** → chọn `td-ship-it/cvht`. **Project name: `cvht`** (để có địa chỉ `cvht.truongduoc.workers.dev`). Giữ cấu hình mặc định.
2. **Settings → Variables and Secrets** thêm:

   | Tên | Loại | Giá trị |
   |---|---|---|
   | `APPS_SCRIPT_URL` | **Secret** | URL `/exec` ở bước 1.4 |
   | `PROXY_KEY` | **Secret** | `PROXY_KEY` trong Nhật ký thực thi |
   | `AI_MODEL` | Text *(tùy chọn)* | Đổi model AI miễn phí, mặc định `@cf/google/gemma-4-26b-a4b-it` |
   | `GEMINI_API_KEY` | **Secret** *(tùy chọn)* | Dùng Google Gemini thay cho AI miễn phí của Cloudflare |
   | `GEMINI_MODEL` | Text *(tùy chọn)* | Mặc định `gemini-3.8-flash` |

3. Mở `https://cvht.truongduoc.workers.dev/api/health` → thấy `"ok":true` và `"workersAI":true` là xong.
4. Đăng nhập bằng `admin` + mật khẩu ở bước 1.3, đặt mật khẩu mới.

Trợ lý AI **tự bật, không cần khóa** nhờ mục `[ai]` trong `wrangler.toml`.
`wrangler.toml` để `crons = []` vì gói miễn phí chỉ có 5 lịch chạy cho cả tài khoản.

## Nạp danh sách người dùng (sheet `NguoiDung`)

| Cột | Ghi chú |
|---|---|
| `TenDangNhap` | MSSV (sinh viên) hoặc email (CVHT). Cột đã đặt dạng chữ nên giữ được số 0 đầu |
| `HoTen` | |
| `VaiTro` | `Sinh viên` · `CVHT` · `Admin` |
| `Lop` | Lớp của sinh viên |
| `CVHT` | Với sinh viên: **email** (hoặc tên đăng nhập / họ tên) của CVHT phụ trách |
| `Email`, `SoDienThoai` | Của CVHT – hiện cho sinh viên ở mục "Của tôi" |
| `MatKhauMacDinh` | Sinh viên: ngày sinh `ddmmyyyy` (dán ngày dạng ngày tháng cũng được). CVHT: mật khẩu tạm |
| `MatKhauHash`, `Salt` | **Để trống** – hệ thống tự điền khi người dùng đổi mật khẩu |
| `TrangThai` | Ghi `Khóa` để chặn đăng nhập |

Dán từ file Excel danh sách lớp là được. Quên mật khẩu: chọn dòng người đó → menu **🎓 Trợ lý CVHT → Đặt lại mật khẩu cho dòng đang chọn**.

## Kho kiến thức cho Trợ lý AI

Trợ lý chỉ trả lời theo nội dung trong sheet `KienThuc` (mỗi dòng 1 Điều / 1 đoạn) và danh mục `TaiLieu`.
Lúc cài đặt, `KienThuc` mới có **phiếu giới thiệu** từng văn bản (tên, phạm vi, Điều cần chú ý, link) – đủ để chỉ đúng văn bản và mẫu đơn, chưa đủ để trả lời chi tiết.

**Nạp toàn văn một quy chế:**
1. Mở PDF, chọn hết chữ (Ctrl+A), sao chép.
2. Sheet `NhapVanBan`: điền **B1** mã văn bản (VD `QCDT`), **B2** tên, **B3** link; dán toàn văn vào ô **A6**.
3. Menu **🎓 Trợ lý CVHT → Tách văn bản ở sheet NhapVanBan thành từng Điều**.
   Hệ thống tách theo "Điều …", ghi Chương vào cột `TuKhoa`, và **thay** các dòng cũ cùng mã (kể cả phiếu giới thiệu).

Dùng đúng mã để thay phiếu giới thiệu: `QDCVHT`, `KHDT`, `QCDT`, `QCCTSV`, `HOCBONG`, `DRL`, `VPTHI`, `CDRNN`, `TBTA`, `HOCPHI`, `TBHP`, `HOTRO`.

- Sửa trực tiếp sheet `KienThuc`/`TaiLieu` cũng được; Trợ lý dùng nội dung mới ở câu hỏi tiếp theo (hoặc chọn **Làm mới kho kiến thức**).
- Văn bản hết hiệu lực: ghi `Không` ở cột `HieuLuc` thay vì xóa.
- Tab "Câu hỏi sinh viên" và cột `DanhGia`/`GopY` của `LichSuHoi` cho biết câu nào trả lời chưa tốt → bổ sung tài liệu tương ứng.

## Giới hạn AI miễn phí

| | Cloudflare Workers AI *(mặc định)* | Google Gemini *(tùy chọn)* |
|---|---|---|
| Cài đặt | Không cần gì | Thêm Secret `GEMINI_API_KEY` |
| Chi phí | 10.000 neuron/ngày, **khoảng 150–200 câu hỏi/ngày cho cả trường**, mở lại 7h sáng | Gói miễn phí giới hạn theo phút/ngày |
| Dữ liệu câu hỏi | Cloudflare không dùng để huấn luyện | Gói miễn phí: Google có thể dùng để cải thiện sản phẩm |

Khi có `GEMINI_API_KEY`, hệ thống dùng Gemini và **tự chuyển** sang Workers AI nếu Gemini hết hạn mức.
Nếu nhiều sinh viên dùng cùng lúc, nên thêm Gemini, hoặc giảm hạn mức mỗi người: **Apps Script → Cài đặt dự án → Thuộc tính tập lệnh** thêm `DAILY_LIMIT_SV` (VD `10`) và `DAILY_LIMIT_STAFF`.
Đổi sang model ít tốn hơn bằng biến `AI_MODEL`, ví dụ `@cf/qwen/qwen3-30b-a3b-fp8`.

## Cập nhật sau này
- Sửa giao diện / Worker: đẩy file mới lên GitHub, Cloudflare tự triển khai.
- Sửa `Code.gs`: dán vào Apps Script → **Triển khai → Quản lý các bản triển khai → ✏️ → Phiên bản mới → Triển khai**.
