# Darkin — Deploy Man

Hệ thống CI/CD & Auto-Deploy nhẹ, gọn thay thế Jenkins, không thư viện phụ thuộc, được xây dựng bằng **Bun**, **Elysia** và **SQLite (`bun:sqlite`)**, tích hợp sẵn **Web UI** quản lý dự án và xem logs thời gian thực.

## Tính năng chính

- **Giao diện Web UI trực quan**: Thêm/sửa/xóa dự án, kiểm tra nhanh đường dẫn thư mục & Git branch trên server, có sẵn các mẫu lệnh (Bun/Elysia, Node/Next.js, Docker Compose, Demo).
- **Chạy lệnh tuần tự bằng `Bun.spawn`**: Mỗi dòng là một step, dừng ngay khi có lỗi (fail-fast), hỗ trợ `auto`, `sh`, `bash`, `cmd`, `powershell`, biến môi trường riêng và timeout.
- **Hàng đợi theo từng dự án**: Tránh 2 build của cùng 1 dự án chạy đè lên nhau, hỗ trợ **Hủy build (Cancel)** khi đang chạy.
- **Xem Console Logs trực tiếp (SSE)**: Stream `stdout`/`stderr` real-time lên trình duyệt, hỗ trợ copy và tải file `.log`.
- **Git Webhook tích hợp sẵn**:
  - Hỗ trợ **GitHub** (xác thực chữ ký `x-hub-signature-256` HMAC-SHA256 & xử lý `ping`), **GitLab** (`x-gitlab-token`) và **Custom Webhook** (`x-webhook-secret` hoặc `?secret=`).
  - Lọc theo branch mục tiêu (`main`, hoặc `*` cho mọi branch).
- **Lưu trữ bền vững bằng `bun:sqlite`**: Tự động lưu cấu hình dự án và lịch sử build tại `data/darkin.sqlite`.

## Khởi chạy

```bash
# Chế độ phát triển (auto-reload)
bun run dev

# Chế độ production
bun run start
```

Mở trình duyệt tại: **http://localhost:7554**

## Chạy bằng Docker / Docker Compose

Image đã đóng gói sẵn **Bun**, **Git**, **Bash**, **OpenSSH**, **tini** và **Docker CLI + Compose plugin** (để deploy các dự án Docker khác khi mount `docker.sock`).

```bash
# Tạo file .env từ mẫu (tùy chọn)
cp .env.example .env

# Build và chạy ngầm bằng Docker Compose
docker compose up -d --build

# Xem logs
docker compose logs -f darkin
```

Hoặc chạy trực tiếp bằng `docker`:

```bash
docker build -t darkin:latest .
docker run -d \
  --name darkin \
  --restart unless-stopped \
  -p 7554:7554 \
  -v darkin_data:/app/data \
  -v /var/www:/workspace \
  darkin:latest
```

> **Mẹo deploy dự án trên VPS:**
> - Mount thư mục code trên host vào `/workspace` (qua biến `DARKIN_PROJECTS_DIR` trong `.env`), sau đó khi thêm dự án trên UI chỉ cần trỏ **WorkDir** tới `/workspace/<ten-du-an>`.
> - Nếu pipeline có chạy `docker compose up -d`, bỏ comment dòng `- /var/run/docker.sock:/var/run/docker.sock` trong `docker-compose.yml`.
> - Nếu dùng SSH key để `git pull` repo private, bỏ comment dòng `- ~/.ssh:/root/.ssh:ro`.

## Biến môi trường (tùy chọn)

| Biến | Mặc định | Mô tả |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | Địa chỉ lắng nghe |
| `PORT` | `7554` | Cổng chạy server |
| `DARKIN_DB` | `data/darkin.sqlite` | Đường dẫn file SQLite |
| `DARKIN_WORKDIR` | *(cwd)* | Thư mục mặc định gợi ý trên UI (trong Docker là `/workspace`) |
| `DARKIN_TOKEN` | *(trống)* | Nếu đặt, yêu cầu nhập token khi truy cập UI & `/api/*` |

## Webhook Endpoints

- `POST /webhook/:slug` — Khuyến nghị (theo slug dự án)
- `POST /webhook?project=<slug>` — Tương thích endpoint mặc định

Ví dụ kích hoạt bằng `curl`:

```bash
curl -X POST "http://localhost:7554/webhook/<slug>" \
  -H "Content-Type: application/json" \
  -H "x-webhook-secret: <secret>" \
  -d '{"branch":"main"}'
```
