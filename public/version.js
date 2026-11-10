// ====================================================================
// PHIÊN BẢN ỨNG DỤNG (APP VERSION)
// Mỗi khi sửa app xong và muốn cập nhật cho các máy của người dùng,
// bạn chỉ cần đổi số version ở dòng dưới rồi đẩy lên GitHub!
// Ví dụ: '1.0.1', '1.0.2', '1.1.0', '2.0.0'...
// ====================================================================
export const APP_VERSION = '2.6';

if (typeof window !== 'undefined') {
  window.__APP_VERSION__ = APP_VERSION;
}
if (typeof self !== 'undefined') {
  self.__APP_VERSION__ = APP_VERSION;
}
