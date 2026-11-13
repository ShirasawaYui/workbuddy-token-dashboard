import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  server: {
    // 与解析服务保持一致：只监听 IPv4 回环，不向局域网暴露 dev server。
    // 本机 localhost 优先解析成 ::1，写 127.0.0.1 才能和只绑 IPv4 的 API 对上。
    host: '127.0.0.1',
    port: 5177,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:5178',
        changeOrigin: true,
      },
    },
  },
});
