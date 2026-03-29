import { defineConfig } from 'vite';
import { viteStaticCopy } from 'vite-plugin-static-copy';
import path from 'path';

/**
 * High-performance Vite build for library-mode distribution.
 * 
 * Tooling:
 * - Vite 8.0.3 (Modern ESM Orchestration)
 * - TypeScript 6.0.2 (Bleeding-edge type safety)
 * - Vite Static Copy 4.0.0 (Clean 'stripBase' flattening)
 */
export default defineConfig({
  plugins: [
    viteStaticCopy({
      targets: [
        {
          src: 'node_modules/onnxruntime-web/dist/*.wasm',
          dest: 'wasm/ort',
          rename: { stripBase: 3 }
        },
        {
          src: 'node_modules/onnxruntime-web/dist/*.mjs',
          dest: 'wasm/ort',
          rename: { stripBase: 3 }
        },
        {
          // CLEAN FLATTENING: Use stripBase to remove 'src/worker/assets/' prefix
          src: 'src/worker/assets/**/*',
          dest: 'worker/assets',
          rename: { stripBase: 3 }
        }
      ]
    })
  ],
  build: {
    lib: {
      entry: {
        index: path.resolve(__dirname, 'src/index.ts'),
        'index-cdn': path.resolve(__dirname, 'src/index-cdn.ts'),
        worker: path.resolve(__dirname, 'src/worker/process-piper-synthesis.worker.ts'),
        cli: path.resolve(__dirname, 'src/cli/provision-assets-full.ts')
      },
      formats: ['es']
    },
    // FORCE SMALL BUNDLE: No inlining of binary data
    assetsInlineLimit: 0,
    rollupOptions: {
      external: [
        'onnxruntime-web', 
        'node:fs', 
        'node:path', 
        'node:process',
        'node:crypto'
      ],
      output: {
        entryFileNames: (chunkInfo) => {
          if (chunkInfo.name === 'cli') return 'cli.js';
          if (chunkInfo.name === 'index-cdn') return 'index-cdn.js';
          return '[name].js';
        }
      }
    }
  }
});
