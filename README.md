# Darkin — Deploy Man

Hệ thống CI/CD & Auto-Deploy nhẹ, gọn thay thế Jenkins (chỉ 1 dependency production là `elysia`), được xây dựng bằng **Bun**, **`Bun.spawn`**, **Elysia** và **SQLite (`bun:sqlite`)**, tích hợp sẵn **Web UI** quản lý dự án và xem logs thời gian thực.

## Tính năng chính

- **Giao diện Web UI trực quan**: Thêm/sửa/xóa dự án, kiểm tra nhanh đường dẫn thư mục & Git branch trên server, có sẵn các mẫu lệnh (*Bun/Elysia*, *Node/Next.js*, *Docker*, *Bash Script*, *Demo*).
- **2 chế độ thực thi bằng `Bun.spawn`**:
  - **Step Mode**: Chạy tuần tự từng dòng, dừng ngay khi có lỗi (fail-fast).
  - **Script Mode**: Chạy nguyên nội dung như một Shell Script hoàn chỉnh (giữ nguyên `cd`, biến `$VAR`, `if/else`, `for`, hỗ trợ shebang `#!` và `bash -e -o pipefail` trên Linux), kèm chọn shell (`auto`, `bash`, `sh`, `cmd`, `powershell`), biến môi trường riêng và timeout.
- **Hàng đợi theo từng dự án**: Tránh 2 build của cùng 1 dự án chạy đè lên nhau (giới hạn tối đa 5 build chờ/dự án), hỗ trợ **Hủy build (Cancel)** khi đang chạy.
- **Xem Console Logs trực tiếp (SSE)**: Stream `stdout`/`stderr` real-time lên trình duyệt, tự động che (`***`) các giá trị secret/token trong logs, hỗ trợ copy và tải file `.log`.
- **Git Webhook tích hợp sẵn**:
  - Hỗ trợ **GitHub** (xác thực chữ ký `x-hub-signature-256` HMAC-SHA256 & xử lý `ping`), **GitLab** (`x-gitlab-token`) và **Custom Webhook** (`x-webhook-secret`).
  - Lọc theo branch mục tiêu (`main`, hoặc `*` cho mọi branch), giới hạn payload 1MB và rate-limit chống brute-force.
- **Bảo mật tích hợp**:
  - Đăng nhập UI bằng `HttpOnly; SameSite=Strict` cookie (tự bật `Secure` qua HTTPS), so sánh token constant-time (`SHA-256` + `timingSafeEqual`), rate-limit theo IP thật, chống CSRF (`Origin` & `Sec-Fetch-Site`), đầy đủ HTTP Security Headers (`CSP`, `X-Frame-Options`, `X-Content-Type-Options`).
  - Tự động loại bỏ `DARKIN_TOKEN` khỏi tiến trình build con và khóa quyền `0600` cho file SQLite / `0700` cho file script tạm trên Linux.
- **Lưu trữ bền vững bằng `bun:sqlite`**: Tự động lưu cấu hình dự án và lịch sử build tại `data/darkin.sqlite`.

## Khởi chạy local

```bash
# Cài dependencies theo lockfile
bun install --frozen-lockfile

# Chế độ phát triển (auto-reload)
bun run dev

# Chế độ production
bun run start
```

Mở trình duyệt tại: **http://localhost:7554**

## Chạy bằng Docker / Docker Compose (VPS Ubuntu)

Image đã đóng gói sẵn **Bun**, **Git**, **Bash**, **OpenSSH** (quét sẵn `known_hosts` cho GitHub/GitLab/Bitbucket), **rsync**, **jq**, **unzip**, **tini** và **Docker CLI + Compose plugin**.

```bash
# 1. Tạo file .env từ mẫu và đặt DARKIN_TOKEN mạnh
cp .env.example .env
# Gợi ý tạo token ngẫu nhiên:
openssl rand -hex 32

# 2. Build và chạy ngầm bằng Docker Compose
docker compose up -d --build

# 3. Xem logs
docker compose logs -f darkin
```

Hoặc chạy trực tiếp bằng `docker`:

```bash
docker build -t darkin:latest .
docker run -d \
  --name darkin \
  --restart unless-stopped \
  -p 127.0.0.1:7554:7554 \
  -e DARKIN_TOKEN="thay-bang-token-manh" \
  -e DARKIN_TRUST_PROXY=true \
  -v darkin_data:/app/data \
  -v /www/wwwroot:/www/wwwroot \
  -v /root/.ssh:/root/.ssh:ro \
  darkin:latest
```

> **Lưu ý khi triển khai trên VPS:**
> - Mặc định `docker-compose.yml` bind vào `127.0.0.1:7554` để tránh Docker vượt tường lửa UFW. Hãy đưa ra Internet thông qua **Nginx Reverse Proxy + HTTPS** bên dưới.
> - Nếu không cần Darkin chạy `docker compose` cho các dự án khác, hãy comment lại dòng `- /var/run/docker.sock:/var/run/docker.sock` trong `docker-compose.yml`.

## Cấu hình Nginx Reverse Proxy (HTTPS + hỗ trợ SSE)

Khi đặt Darkin sau Nginx trên VPS, bật `DARKIN_TRUST_PROXY=true` trong `.env` và cấu hình Nginx mẫu:

```nginx
server {
    listen 443 ssl http2;
    server_name deploy.example.com;

    # ssl_certificate ...
    # ssl_certificate_key ...

    location / {
        proxy_pass http://127.0.0.1:7554;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Cần thiết cho live Console Logs (SSE)
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;
    }
}
```

## Biến môi trường

| Biến | Mặc định | Mô tả |
| --- | --- | --- |
| `BIND_HOST` | `127.0.0.1` | Địa chỉ bind trên host trong `docker-compose.yml` |
| `HOST` | `0.0.0.0` | Địa chỉ lắng nghe bên trong server/container |
| `PORT` | `7554` | Cổng chạy server |
| `DARKIN_DB` | `data/darkin.sqlite` | Đường dẫn file SQLite |
| `DARKIN_WORKDIR` | *(cwd)* | Thư mục mặc định gợi ý trên UI |
| `DARKIN_TOKEN` | *(trống)* | **Bắt buộc đặt khi chạy VPS** — bảo vệ toàn bộ UI & `/api/*` |
| `DARKIN_TRUST_PROXY` | `false` | Đặt `true` khi chạy sau Nginx/Cloudflare Reverse Proxy |

## Webhook Endpoints

- `POST /webhook/:slug` — Khuyến nghị (theo slug dự án)
- `POST /webhook?project=<slug>` — Tương thích endpoint mặc định

Ví dụ kích hoạt bằng `curl`:

```bash
curl -X POST "https://deploy.example.com/webhook/<slug>" \
  -H "Content-Type: application/json" \
  -H "x-webhook-secret: <secret>" \
  -d '{"branch":"main"}'
```
