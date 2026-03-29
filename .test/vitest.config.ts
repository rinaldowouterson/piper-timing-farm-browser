import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: [path.resolve(__dirname, './setup.ts')],
    // Search relative to the project root
    include: ['src/**/*.test.ts', '.test/**/*.test.ts'],
    root: path.resolve(__dirname, '..'),
    testTimeout: 30000
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '../src'),
    },
  },
});
