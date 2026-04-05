import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: [path.resolve(__dirname, './setup.ts')],
    // All tests are centralized in .test folder
    include: ['.test/**/*.test.ts'],
    root: path.resolve(__dirname, '..'),
    testTimeout: 30000
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '../src'),
    },
  },
});
