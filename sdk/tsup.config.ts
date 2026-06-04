import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  // Code-split so each dynamically-imported non-EVM driver (Solana, TON) lands
  // in its own chunk — pure-EVM consumers never load it (or its libraries).
  splitting: true,
  sourcemap: false,
  clean: true,
  minify: false,
  target: 'es2022',
  // Peers — consumers bring their own. Keeping these external preserves the
  // literal `import('@solana/web3.js')` / `import('@ton/ton')` so they resolve
  // at runtime only when that family is actually used (with a friendly error
  // if the packages are absent).
  external: [
    'viem',
    '@aptos-labs/ts-sdk',
    '@solana/web3.js',
    '@solana/spl-token',
    'bs58',
    '@ton/ton',
    '@ton/core',
    '@ton/crypto',
    '@stellar/stellar-sdk',
    'xrpl',
    'tronweb',
    // @mysten/sui is imported via subpaths (/jsonRpc, /transactions, …) — externalize
    // the package and all its subpaths so they stay lazy runtime imports.
    '@mysten/sui',
    '@mysten/sui/*',
    'near-api-js',
  ],
})
