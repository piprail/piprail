import { defineConfig } from 'tsup'

// The SDK's non-EVM drivers are optional peers loaded via dynamic import() and are out of scope
// for the EVM-only v1 node. They MUST be external so esbuild doesn't try to resolve uninstalled
// packages — they are never reached on an EVM chain. n8n-workflow is provided by the host.
const SDK_OPTIONAL_PEERS = [
  '@aptos-labs/ts-sdk',
  '@solana/web3.js',
  '@solana/spl-token',
  '@stellar/stellar-sdk',
  'bs58',
  '@ton/ton',
  '@ton/core',
  '@ton/crypto',
  'xrpl',
  'tronweb',
  '@mysten/sui',
  'near-api-js',
  'algosdk',
  'borsh',
]

export default defineConfig({
  // Object entries pin the exact output paths n8n's package.json `n8n` block points at.
  entry: {
    'nodes/Piprail/Piprail.node': 'nodes/Piprail/Piprail.node.ts',
    'credentials/PiprailApi.credentials': 'credentials/PiprailApi.credentials.ts',
  },
  format: ['cjs'], // n8n loads CommonJS nodes
  target: 'node20',
  outDir: 'dist',
  clean: true,
  dts: false,
  sourcemap: false,
  splitting: false,
  external: ['n8n-workflow', ...SDK_OPTIONAL_PEERS],
  // Force the SDK + its one required peer (viem) INTO the bundle → zero runtime dependencies.
  noExternal: ['@piprail/sdk', 'viem'],
  // n8n resolves `file:piprail.svg` relative to the compiled node — copy the icons next to it.
  onSuccess: 'cp nodes/Piprail/piprail.svg nodes/Piprail/piprail.dark.svg dist/nodes/Piprail/',
})
