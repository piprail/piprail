#!/usr/bin/env node
/*
 * Generates site/src/data/swap-providers.ts from the SDK's SWAP_PROVIDERS map.
 *
 * The site does not depend on @piprail/sdk (same as chains.ts and facilitators.ts), so this
 * mirrors the data at build time instead. Re-run after any change to sdk/src/swapProviders.ts:
 *   node site/scripts/gen-swap-providers.mjs
 *
 * WHY GENERATE RATHER THAN HAND-WRITE
 * ───────────────────────────────────
 * One fact — "what can swap where, and what proves it" — would otherwise live in the SDK, the
 * docs table and this page independently. That is exactly the shape that rotted the facilitator
 * data, where the registry was fixed and three other surfaces kept advertising two dead hosts
 * for the rest of the day. So the registry is the only source, and everything else derives.
 *
 * The page needs display metadata the SDK has no business carrying (chain names, block explorer
 * URLs, logo slugs), so that lives here, keyed by CAIP-2, and the generated file is
 * self-contained and readable in a diff.
 */
import { writeFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { SWAP_PROVIDERS } = require('../../sdk/dist/index.cjs')

/** CAIP-2 → display name, the logo slug already in site/public/chains/, and its explorer. */
const CHAIN_META = {
  'stellar:pubnet': { name: 'Stellar', slug: 'stellar', explorer: 'https://stellar.expert/explorer/public/tx/' },
  'xrpl:0': { name: 'XRP Ledger', slug: 'xrpl', explorer: 'https://xrpscan.com/tx/' },
  'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp': { name: 'Solana', slug: 'solana', explorer: 'https://solscan.io/tx/' },
  'eip155:1': { name: 'Ethereum', slug: 'ethereum', explorer: 'https://etherscan.io/tx/' },
  'eip155:10': { name: 'Optimism', slug: 'optimism', explorer: 'https://optimistic.etherscan.io/tx/' },
  'eip155:56': { name: 'BNB Chain', slug: 'bnb', explorer: 'https://bscscan.com/tx/' },
  'eip155:137': { name: 'Polygon', slug: 'polygon', explorer: 'https://polygonscan.com/tx/' },
  'eip155:8453': { name: 'Base', slug: 'base', explorer: 'https://basescan.org/tx/' },
  'eip155:42161': { name: 'Arbitrum', slug: 'arbitrum', explorer: 'https://arbiscan.io/tx/' },
  'eip155:43114': { name: 'Avalanche', slug: 'avalanche', explorer: 'https://snowtrace.io/tx/' },
  'eip155:59144': { name: 'Linea', slug: 'linea', explorer: 'https://lineascan.build/tx/' },
  'eip155:4663': { name: 'Robinhood', slug: 'robinhood', explorer: 'https://robinhoodchain.blockscout.com/tx/' },
  'aptos:1': { name: 'Aptos', slug: 'aptos', explorer: 'https://explorer.aptoslabs.com/txn/' },
  'tvm:-239': { name: 'TON', slug: 'ton', explorer: 'https://tonviewer.com/transaction/' },
  'tron:mainnet': { name: 'Tron', slug: 'tron', explorer: 'https://tronscan.org/#/transaction/' },
  'sui:mainnet': { name: 'Sui', slug: 'sui', explorer: 'https://suiscan.xyz/mainnet/tx/' },
  'near:mainnet': { name: 'NEAR', slug: 'near', explorer: 'https://nearblocks.io/txns/' },
  'algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=': { name: 'Algorand', slug: 'algorand', explorer: 'https://allo.info/tx/' },
}

/*
 * Logos are SVG where the provider ships a usable vector and WebP where they only ship a
 * raster (Aftermath publishes a 48px icon; Vestige a 192px PNG; Ref's vector is 77 KB for a
 * 40px slot, so it is rasterised). The extension is RESOLVED from disk rather than assumed,
 * so a provider added with the other format cannot silently render a broken image.
 */
const LOGO_EXTS = ['svg', 'webp', 'png']
function logoFor(id) {
  for (const ext of LOGO_EXTS) {
    if (existsSync(new URL(`../public/swaps/${id}.${ext}`, import.meta.url))) return `${id}.${ext}`
  }
  return null
}

const missing = [...new Set(SWAP_PROVIDERS.flatMap((p) => p.networks))].filter((n) => !CHAIN_META[n])
if (missing.length) {
  // Fail loudly. Rendering a network with no display metadata would silently drop it
  // from the page, which is the quiet kind of drift this generator exists to prevent.
  console.error(`gen-swap-providers: no CHAIN_META for: ${missing.join(', ')}`)
  process.exit(1)
}

const noLogo = SWAP_PROVIDERS.filter((p) => !logoFor(p.id))
if (noLogo.length) {
  console.error(`gen-swap-providers: no logo in site/public/swaps/ for: ${noLogo.map((p) => p.id).join(', ')}`)
  process.exit(1)
}

const entries = SWAP_PROVIDERS.map((p) => ({
  id: p.id,
  logo: logoFor(p.id),
  name: p.name,
  kind: p.kind,
  url: p.url,
  host: new URL(p.url).host.replace(/^www\./, ''),
  keyless: p.keyless,
  fee: p.fee,
  mechanism: p.mechanism,
  ...(p.unproven ? { unproven: p.unproven } : {}),
  chains: p.networks.map((n) => ({ caip2: n, ...CHAIN_META[n] })),
  proofs: p.proofs.map((t) => ({
    ...t,
    chain: CHAIN_META[t.network].name,
    slug: CHAIN_META[t.network].slug,
    url: `${CHAIN_META[t.network].explorer}${t.tx}`,
    short: t.tx.length > 14 ? `${t.tx.slice(0, 8)}…${t.tx.slice(-4)}` : t.tx,
  })),
}))

const protocolCount = entries.filter((e) => e.kind === 'protocol').length
const providerCount = entries.filter((e) => e.kind === 'provider').length
const chainCount = new Set(SWAP_PROVIDERS.flatMap((p) => p.networks)).size
const proofCount = entries.reduce((n, e) => n + e.proofs.length, 0)

const out = `// ⚠️ GENERATED. Do not edit by hand.
// Source: sdk/src/swapProviders.ts (SWAP_PROVIDERS)
// Regenerate: node site/scripts/gen-swap-providers.mjs
//
// Every entry is a swap route we settled a REAL mainnet transaction through, on the dated
// day, and then verified by reading it back from a public node. Never seeded from a
// documentation page: a quote proves routing, only a transaction proves settlement.

export interface SwapProofView {
  network: string
  tx: string
  date: string
  summary: string
  covers?: string
  chain: string
  slug: string
  url: string
  short: string
}
export interface SwapChainView {
  caip2: string
  name: string
  slug: string
  explorer: string
}
export interface SwapProviderView {
  id: string
  /** Filename inside /swaps/, extension resolved from disk (svg or webp). */
  logo: string
  name: string
  /** 'protocol' = the ledger itself swaps, no third party. 'provider' = a named router. */
  kind: 'protocol' | 'provider'
  url: string
  host: string
  keyless: boolean
  fee: string
  mechanism: string
  /** Set only when the route ships WITHOUT a mainnet proof, naming the reason. */
  unproven?: string
  chains: SwapChainView[]
  proofs: SwapProofView[]
}

export const SWAP_PROVIDERS: SwapProviderView[] = ${JSON.stringify(entries, null, 2)}

/** Routes where the LEDGER swaps and no third party is involved. */
export const PROTOCOL_COUNT = ${protocolCount}
/** Routes handled by a named third-party router. */
export const PROVIDER_COUNT = ${providerCount}
/** Distinct chains with a proven swap route. */
export const SWAP_CHAIN_COUNT = ${chainCount}
/** Real mainnet transactions backing the table. */
export const SWAP_PROOF_COUNT = ${proofCount}
`

writeFileSync(new URL('../src/data/swap-providers.ts', import.meta.url), out)
console.log(
  `swap-providers.ts: ${entries.length} routes (${protocolCount} protocol, ${providerCount} provider) · ${chainCount} chains · ${proofCount} proofs`
)
