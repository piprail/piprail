import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  // @elizaos/core is a peer (the host runtime provides it); @piprail/sdk stays a normal dep.
  external: ['@elizaos/core'],
})
