export const APP_VERSION = '1.0.19';

if (typeof window !== 'undefined') {
  window.__APP_VERSION__ = APP_VERSION;
}
if (typeof self !== 'undefined') {
  self.__APP_VERSION__ = APP_VERSION;
}
