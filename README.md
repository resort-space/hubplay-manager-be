# Backend HubPlay

NestJS + Prisma + PostgreSQL. API prefix `/api/v1`.

## Chạy local

Dòng `npm warn Unknown env config "devdir"` đến từ biến `npm_config_devdir` của Cursor. Đó không phải lỗi cài package. `npm install` im đến khi xong rồi mới in `added N packages`. Đừng bấm lại khi mới thấy dòng cảnh báo. Nếu treo ở `prisma -v` trong postinstall, cài bằng `npm install --ignore-scripts` rồi chạy `node node_modules/prisma/build/index.js generate`.

Database nằm trong `.env` (`DATABASE_URL`). Prisma không nhận tiền tố `jdbc:`. URL đúng dạng `postgresql://user:password@host:5432/postgres`. Cổng trong URL là cổng Postgres. API nghe `HOST` + `PORT` (mặc định `127.0.0.1:3001`).

`.gitignore` trong thư mục này bỏ `.env`, `node_modules`, `dist`, `uploads`, Postgres local (`pgdata`, `tools`). Khi tách repo, copy cả thư mục `backend/`. File mẫu env là `.env.example`. Trên VPS: `OTP_DEV=false`, `COOKIE_SECURE=true`, `JWT_SECRET` riêng. `OTP_DEV=false` không trả mã OTP và chưa gửi SMS, nên đăng nhập khách chỉ chạy khi còn `OTP_DEV=true` hoặc khi đã nối SMS. `HOST=127.0.0.1` khi Next cùng máy. Đừng mở cổng `3001` và cổng Postgres ra internet.

```
copy .env.example .env
npm run build
node dist/main.js
```

Tài khoản seed, mật khẩu `Admin@123`:

- `sysadmin` — system-admin
- `editadmin` — edit-admin
- `quay` — admin quầy

OTP dev luôn là `000000` khi `OTP_DEV=true`.

Cơ sở seed: Door Escape, 6 ngõ 78 đường Lương Ngọc Quyến, mã `DER`.
