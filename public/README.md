# Đi chơi, chia tiền

PWA tiếng Việt để một người quản lý ghi chi tiêu cho nhóm, khởi tạo với 4 thành viên rồi có thể thêm người, chia đều hoặc tùy chỉnh, xem số dư và ghi nhận quyết toán.

## Chạy local

```bash
npm install
npm run dev
```

Khi chưa cấu hình Supabase, app chạy ở chế độ cục bộ và lưu dữ liệu trong IndexedDB trên trình duyệt hiện tại. Dữ liệu ở chế độ này không đồng bộ sang thiết bị khác.

## Kết nối Supabase

1. Tạo một project Supabase.
2. Chạy các file migration trong `supabase/migrations` theo thứ tự thời gian trong SQL Editor. Migration mới cần chạy trên project đã có schema cũ để cập nhật DB.
3. Tạo `.env.local` từ `.env.example`, rồi đặt `VITE_SUPABASE_URL` và `VITE_SUPABASE_PUBLISHABLE_KEY`.
4. Khởi động lại app. Tạo tài khoản quản lý, xác nhận email nếu Supabase yêu cầu, đăng nhập và tạo sổ với bốn thành viên.

App chỉ dùng publishable key ở trình duyệt (có thể dùng anon key legacy nếu project chưa có publishable key). Không dùng secret/service_role key ở frontend. Mọi bảng bật RLS; đọc dữ liệu bị giới hạn theo tài khoản sở hữu sổ, còn thao tác ghi đi qua các RPC đã kiểm tra quyền.

## Offline

Service worker cache giao diện. Dữ liệu sổ và hàng đợi thay đổi được lưu trong IndexedDB. Khi có mạng, app đồng bộ lần lượt và dùng mã thao tác để tránh ghi lặp. Nếu một khoản chi đã thay đổi trên server, app dừng hàng đợi tại thao tác đó và cho chọn tải bản server hoặc áp dụng lại chỉnh sửa cục bộ.

## Deploy

Kết nối repository GitHub này với Vercel hoặc import project trong Vercel. Framework là Vite, build command `npm run build`, output `dist`. Thêm `VITE_SUPABASE_URL` và `VITE_SUPABASE_PUBLISHABLE_KEY` vào project Vercel cho Production, Preview và Development. Sau deploy qua HTTPS, PWA có thể cài từ trình duyệt.

## Lệnh kiểm tra

```bash
npm run build
```
