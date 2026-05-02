import { defineConfig } from 'vite';
import { viteStaticCopy } from 'vite-plugin-static-copy';
import dts from 'vite-plugin-dts';
import path from 'path';
import fs from 'fs';

/**
 * Automates permissions for the CLI executable after build.
 */
function cliPermissionPlugin() {
  return {
    name: 'cli-permission-plugin',
    closeBundle() {
      const cliPath = path.resolve(__dirname, 'dist/cli.js');
      if (fs.existsSync(cliPath)) {
        fs.chmodSync(cliPath, 0o755);
        console.log('  [OK] Set executable permissions for dist/cli.js');
      }
    }
  };
}

/**
 * High-performance Vite build for library-mode distribution.
 * 
 * Asset Strategy ("The Great Flattening"):
 * All binary assets are consolidated into a single `dist/piper-gate/` directory.
 * - ORT assets sourced from node_modules (version-locked, no drift)
 * - Piper assets sourced from node_modules (version-locked, no drift)
 *
 * Build Strategy (Industry Standard):
 * - Unified ESM output (no CJS/UMD bloat)
 * - Synchronized type definitions via vite-plugin-dts
 * - Automated CLI provisioning
 */
export default defineConfig({
  plugins: [
    dts({
      rollupTypes: true,
      insertTypesEntry: true,
      exclude: ['src/control-asset-sw.ts', 'src/cli/provision-assets-full.ts'],
    }),
    cliPermissionPlugin(),
    {
      name: 'clean-dist-plugin',
      closeBundle() {
        const folders = ['farm', 'utils', 'providers', 'worker', 'cli', 'types'];
        for (const folder of folders) {
          const folderPath = path.resolve(__dirname, 'dist', folder);
          if (fs.existsSync(folderPath)) {
            fs.rmSync(folderPath, { recursive: true, force: true });
          }
        }
        // Remove standard vite-env ghost
        const envFile = path.resolve(__dirname, 'dist/vite-env.d.ts');
        if (fs.existsSync(envFile)) fs.unlinkSync(envFile);
      }
    },
    viteStaticCopy({
      targets: [
        // ORT runtime assets — sourced from node_modules to prevent version drift
        {
          src: 'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm',
          dest: 'assets',
          rename: { stripBase: 3 }
        },
        {
          src: 'node_modules/onnxruntime-web/dist/ort.wasm.min.mjs',
          dest: 'assets',
          rename: { stripBase: 3 }
        },
        {
          src: 'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs',
          dest: 'assets',
          rename: { stripBase: 3 }
        },
        // Piper phonemize assets — sourced from node_modules to prevent version drift
        {
          src: 'node_modules/@diffusionstudio/piper-wasm/build/piper_phonemize.data',
          dest: 'assets',
          rename: { stripBase: 4 }
        },
        {
          src: 'node_modules/@diffusionstudio/piper-wasm/build/piper_phonemize.js',
          dest: 'assets',
          rename: { stripBase: 4 }
        },
        {
          src: 'node_modules/@diffusionstudio/piper-wasm/build/piper_phonemize.wasm',
          dest: 'assets',
          rename: { stripBase: 4 }
        },
        // Model cards — Single Source of Truth for voice integrity
        {
          src: 'src/piper-model-cards.json',
          dest: 'assets',
          rename: { stripBase: 1 }
        }
      ]
    })
  ],
  worker: {
    rollupOptions: {
      output: {
        entryFileNames: 'assets/[name].js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name].[ext]'
      }
    }
  },
  build: {
    lib: {
      entry: {
        index: path.resolve(__dirname, 'src/index.ts'),
        cli: path.resolve(__dirname, 'src/cli/provision-assets-full.ts'),
        'control-asset-sw': path.resolve(__dirname, 'src/control-asset-sw.ts'),
        worker: path.resolve(__dirname, 'src/worker/index.ts'),
      },
      formats: ['es']
    },
    // FORCE SMALL BUNDLE: No inlining of binary data
    assetsInlineLimit: 0,
    rollupOptions: {
      external: [
        'onnxruntime-web', 
        '@diffusionstudio/piper-wasm',
        'node:fs', 
        'node:path', 
        'node:process',
        'node:crypto',
        'node:url'
      ],
      output: {
        entryFileNames: (chunkInfo) => {
          if (chunkInfo.name === 'cli') return 'cli.js';
          if (chunkInfo.name === 'index') return 'index.js';
          if (chunkInfo.name === 'worker') return 'process-piper-synthesis.worker.js';
          if (chunkInfo.name === 'control-asset-sw') return 'control-asset-sw.js';
          return '[name].js';
        },
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name].[ext]'
      }
    }
  }
});

