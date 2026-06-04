import { defineConfig } from 'tsup'

export default defineConfig({
  // Two entries: `index` is the importable library; `bin` is the executable.
  // The shebang lives in src/bin.ts (esbuild preserves it) so it lands ONLY on
  // dist/bin.js — never on dist/index.js, where a `#!` line would break `import`.
  entry: ['src/index.ts', 'src/bin.ts'],
  format: ['esm'], // a server binary is not a library — ESM-only, no CJS dead weight
  target: 'node20',
  // Types only for the library entry; the bin needs no .d.ts.
  dts: { entry: 'src/index.ts' },
  clean: true,
  sourcemap: false,
  minify: false,
  shims: false,
  // ALL dependencies are externalized by tsup automatically (nothing is bundled):
  // @modelcontextprotocol/sdk, @piprail/sdk (+ its lazy non-EVM peers), and zod
  // resolve from node_modules at runtime. viem isn't imported here at all — the
  // SDK needs it for EVM, so we declare it a direct dependency to guarantee npm
  // installs it for the out-of-the-box `npx` EVM path.
})
