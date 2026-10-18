# Backend HubPlay

NestJS + Prisma + PostgreSQL. API prefix `/api/v1`.

## Chạy local

Dòng `npm warn Unknown env config "devdir"` đến từ biến `npm_config_devdir` của Cursor. Đó không phải lỗi cài package. `npm install` im đến khi xong rồi mới in `added N packages`. Đừng bấm lại khi mới thấy dòng cảnh báo. Nếu treo ở `prisma -v` trong postinstall, cài bằng `npm install --ignore-scripts` rồi chạy `node node_modules/prisma/build/index.js generate`.

Database nằm trong `.env` (`DATABASE_URL`). Prisma không nhận tiền tố `jdbc:`. URL đúng dạng `postgresql://user:password@host:5432/postgres`. Cổng trong URL là cổng Postgres. API nghe `HOST` + `PORT` (mặc định `127.0.0.1:3001`).

`.gitignore` trong thư mục này bỏ `.env`, `node_modules`, `dist`, `uploads`, Postgres local (`pgdata`, `tools`). Khi tách repo, copy cả thư mục `backend/`. File mẫu env là `.env.example`. Trên VPS: `OTP_DEV=false`, `COOKIE_SECURE=true`, `JWT_SECRET` riêng. `OTP_DEV=false` không trả mã OTP và chưa gửi SMS. Đăng ký khách cần mã OTP để xác nhận SĐT, nên chỉ chạy khi còn `OTP_DEV=true` hoặc khi đã nối SMS. Đăng nhập sau đó dùng SĐT và mật khẩu, không cần OTP. `HOST=127.0.0.1` khi Next cùng máy. Đừng mở cổng `3001` và cổng Postgres ra internet.

```
copy .env.example .env
npm run build
node dist/main.js
```

Tài khoản seed, mật khẩu `Admin@123`:

- `sysadmin` — system-admin
- `editadmin` — edit-admin
- `quay` — admin quầy

OTP xác nhận SĐT lúc đăng ký luôn là `000000` khi `OTP_DEV=true`.

Cơ sở seed: Door Escape, 6 ngõ 78 đường Lương Ngọc Quyến, mã `DER`.

In phiếu qua QZ Tray cần chứng chỉ ký. Lần đầu gọi `/api/v1/qz/certificate` hoặc `/api/v1/qz/sign`, server tạo cặp khóa trong thư mục `qz/` (đã nằm trong `.gitignore`). Khóa riêng không đưa lên git. Chỉ admin đã đăng nhập mới lấy chứng chỉ và chữ ký.

QZ Tray báo **Untrusted website** và **Invalid certificate** khi chưa cài chứng chỉ này. Trên máy quầy:

1. Copy `qz/certificate.pem`. Không copy `qz/private-key.pem`.
2. Đổi tên thành `override.crt`.
3. Dán vào thư mục cài QZ Tray, thường là `C:\Program Files\QZ Tray\`. Nếu Windows không cho ghi, dán vào `%AppData%\qz\`.
4. Chuột phải icon QZ Tray, chọn **Exit**, rồi mở QZ Tray lại.
5. Tải lại trang quầy, bấm **Lưu và in**. Tick **Remember** rồi bấm **Allow**.

QZ Tray phải đang chạy. Web tìm máy có tên **XP-T80L** hoặc **Xprinter**, không có thì dùng máy in mặc định. Không chọn máy in trong QZ.


## In phiếu trên VPS

VPS không nối tới QZ Tray và không nối tới máy in. Trình duyệt trên máy quầy nối vào QZ Tray đang chạy trên chính máy đó (`wss://localhost:8181`). Nest chỉ ký yêu cầu khi admin đã đăng nhập.

Trang quầy phải là **HTTPS**. Đang mở bằng `http://` thì `qz-tray.js` bỏ cổng 8181 và chỉ thử `ws://localhost:8182`. Chrome còn chặn trang công cộng gọi `localhost`, log dạng `ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS`. Domain tạm `*.sslip.io` của Coolify thường là HTTP, và Let's Encrypt hay từ chối chứng chỉ vì quá nhiều site dùng chung `sslip.io`. Khi có tên miền riêng, trỏ bản ghi A về IP VPS, rồi trong Coolify (service frontend) đổi ô Domains thành `https://tên-miền`. Save để proxy xin chứng chỉ. Mở trang quầy bằng địa chỉ có ổ khóa.

### Giữ một cặp khóa

Trong Coolify, service backend, mục Storages, thêm volume. Destination Path: `/app/qz`. Deploy lại.

Terminal của service backend:

```
pwd
ls -la /app/qz
```

`pwd` phải là `/app`. Nếu là thư mục khác thì Destination Path là thư mục đó cộng `/qz`.

Thư mục trống thì lần in đầu server tự sinh cặp khóa mới. Muốn dùng đúng cặp đang có trên máy dev, dán file vào trước khi ai bấm in. Không copy `private-key.pem` ra máy quầy.

```
cat > /app/qz/certificate.pem
cat > /app/qz/private-key.pem
```

Mỗi lệnh: dán nội dung, Enter, rồi `Ctrl+D`. Kiểm tra dòng đầu:

```
head -n 1 /app/qz/certificate.pem /app/qz/private-key.pem
```

Phải thấy `-----BEGIN CERTIFICATE-----` và `-----BEGIN PRIVATE KEY-----` (hoặc `BEGIN RSA PRIVATE KEY`).

Volume còn thì các lần deploy sau giữ nguyên cặp khóa. Volume trống lúc app khởi động sẽ sinh chứng chỉ khác và `override.crt` cũ hết dùng.

### Máy quầy

1. Copy `certificate.pem` (trong container hoặc bản local cùng cặp), lưu thành `override.crt`.
2. Dán vào `C:\Program Files\QZ Tray\`. Windows không cho ghi thì dán vào `%AppData%\qz\`.
3. Exit QZ Tray rồi mở lại.
4. So khớp với chứng chỉ server. Hai mã phải giống nhau:

```
openssl x509 -in /app/qz/certificate.pem -noout -fingerprint -sha256
```

Trên máy quầy:

```
certutil -dump "$env:ProgramFiles\QZ Tray\override.crt" | findstr "Cert Hash(sha256)"
```

`certutil -hashfile` băm cả file nên không dùng để so với `openssl`.

5. QZ Tray đang chạy ở khay hệ thống. Mở trang quầy **HTTPS** trên Chrome của máy quầy. Ổ khóa → Cài đặt trang → **Quyền truy cập mạng cục bộ** → **Cho phép**. Bấm **Lưu và in**, tick **Remember**, bấm **Allow**.

Console phải có dòng `wss://localhost:8181`. Chỉ thấy `ws://` thì trang vẫn là HTTP.

### Test khi chưa có tên miền

Chỉ làm trên Chrome của máy quầy. Mở `chrome://flags/#local-network-access-check`, chọn **Disabled**, bấm **Relaunch**. QZ Tray đang chạy, rồi in từ đúng URL HTTP hiện tại (kể cả `http://….sslip.io`).

Cờ này tắt chặn của Chrome trên máy đó. Khi site đã là HTTPS, trả cờ về **Default** và cho phép quyền truy cập mạng cục bộ cho địa chỉ HTTPS.