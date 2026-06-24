import { defineConfig } from 'tsup'

export default defineConfig({
  // One executable. `bin.ts` imports `index.ts` + `render.ts`, so they bundle in.
  // The shebang lives in src/bin.ts (esbuild preserves it) → only on dist/bin.js.
  entry: ['src/bin.ts'],
  format: ['esm'], // a CLI is not a library — ESM-only.
  target: 'node20',
  dts: false,
  clean: true,
  sourcemap: false,
  minify: false,
})
