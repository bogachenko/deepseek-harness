import { defineConfig } from 'tsdown'

/** Build the V8-compatible initiator provider without Node platform APIs. */
export default defineConfig([
  {
    entry: ['lib/types/index.js'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'neutral',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
  },
])
