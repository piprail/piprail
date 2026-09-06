/**
 * THE REGRESSION LOCK — the real client against 60 REAL x402 challenges.
 *
 * On 2026-09-06 this SDK had 1,636 green tests, a live suite that round-tripped against its own
 * gate, and a docs page titled "Pay any x402 server" — and a probe of seven real third-party 402s
 * paid ZERO of them. The buyer required `extra.assetTransferMethod`, a field the exact-EVM scheme
 * makes optional (absent ⇒ `eip3009`) and the SVM/Algorand/Aptos/NEAR/Hedera schemes never define
 * at all. 91% of the deployed web omits it. Every unit test agreed with its own hand-built
 * fixture; nothing checked the fixtures against the world.
 *
 * So the world IS the fixture here. `sdk/test/fixtures/x402-corpus/` holds 60 challenges captured
 * from the live CDP Bazaar (`npm run x402:coverage -- --fixture …`), stratified by wire shape, each
 * with a human-reviewed expected verdict in MANIFEST.json. This suite replays each one through a
 * real `PipRailClient.planPayment()` on a stub driver and asserts that verdict.
 *
 * If you are here because a fixture went red: do NOT edit the fixture. It is a recording of what a
 * real merchant actually serves. Either the code regressed, or the expectation genuinely changed
 * (a stage landed) — in which case update MANIFEST.json's `expect` deliberately, in the same PR.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  PipRailClient,
  registerDriver,
  type ResolvedNetwork,
  type X402ExactAcceptEntry,
  type ExactPaymentPayload,
} from '../src/index.js'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'x402-corpus')

interface ManifestRow {
  file: string
  shape: string
  source: string
  /** The rail this fixture is ABOUT — the client is bound to this network. */
  network: string
  scheme: string
  fetched: string
  expect: 'payable' | 'blocked'
  why: string
}

/** The challenge as a merchant serves it (v2 object form, or v1 with per-accept resource). */
interface Fixture {
  x402Version: 1 | 2
  resource?: { url: string }
  accepts: Record<string, unknown>[]
}

const manifest: ManifestRow[] = existsSync(join(FIXTURES, 'MANIFEST.json'))
  ? (JSON.parse(readFileSync(join(FIXTURES, 'MANIFEST.json'), 'utf8')) as ManifestRow[])
  : []

/**
 * A stub driver for whichever family a fixture's rail names. It answers the same questions the
 * real driver would — `supports`, `describeAsset`, and the presence of `payExact` — because those
 * are exactly the inputs `gatherCandidates` keys on. Balances are generous so the ONLY thing that
 * can make a rail unpayable here is the rail-shape logic under test.
 */
/** The families whose drivers really expose a `payExact` SPI today (grep it under
 *  `src/drivers`). XRPL, Stellar, Sui, TON and Tron do NOT — which is exactly why their fixtures
 *  must come back `blocked` until stage 04 builds those buyers. A stub that handed `payExact` to
 *  every family would report the moat as already crossed. */
const FAMILIES_WITH_PAY_EXACT = new Set(['evm', 'solana', 'algorand', 'aptos', 'near'])
/** `payUpto` is EVM-Permit2 only (the upto spec has no non-EVM variant). */
const FAMILIES_WITH_PAY_UPTO = new Set(['evm'])

function stubNetFor(network: string, assets: string[]): ResolvedNetwork {
  const family = network.startsWith('eip155:')
    ? 'evm'
    : network.split(':')[0]!.replace('tvm', 'ton')
  const known = new Set(assets.map((a) => a.toLowerCase()))
  return {
    family,
    network,
    // Mirror the real drivers: an exact-string match on the bound CAIP-2 id. The client normalises
    // slugs and aliases BEFORE calling this, so a fixture using the Algorand spec-form id or a v1
    // slug only passes if that canonicalisation actually happened.
    supports: (n: string) => n === network,
    resolveToken: () => ({ asset: assets[0]!, decimals: 6, symbol: 'USDC' }),
    describeAsset: (a: string) =>
      a === 'native'
        ? { symbol: 'NATIVE', decimals: 18 }
        : known.has(a.toLowerCase())
          ? { symbol: 'USDC', decimals: 6 }
          : null,
    assertValidPayTo: () => undefined,
    bindWallet: (w: unknown) => ({ _native: w }),
    send: async () => 'ref',
    confirm: async () => ({ height: '1' }),
    estimateCost: async () => ({ feeSymbol: 'NATIVE', feeDecimals: 18, fee: '0', feeFormatted: '0', basis: 'estimated' as const }),
    balanceOf: async () => ({ token: 10n ** 12n, native: 10n ** 18n }),
    recipientReady: async () => ({ ready: 'n/a' as const }),
    verify: async () => ({ ok: false, error: 'transfer_not_found', detail: 'unused' }),
    ...(FAMILIES_WITH_PAY_EXACT.has(family)
      ? {
          payExact: async (_w: unknown, accept: X402ExactAcceptEntry) => ({
            payload: { signature: `0x${'ab'.repeat(65)}`, authorization: { from: '0xP', to: accept.payTo, value: accept.amount, validAfter: '0', validBefore: '9999999999', nonce: '0x1' } } as ExactPaymentPayload,
            accepted: accept,
            payerFrom: '0xP',
            nonce: '0x1',
          }),
        }
      : {}),
    ...(FAMILIES_WITH_PAY_UPTO.has(family)
      ? {
          payUpto: async (_w: unknown, accept: X402ExactAcceptEntry) => ({
            payload: { signature: `0x${'ab'.repeat(65)}`, permit2Authorization: {} },
            accepted: accept,
            payerFrom: '0xP',
            nonce: '0x1',
          }),
        }
      : {}),
  } as unknown as ResolvedNetwork
}

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

describe('x402 corpus — the real client against real merchant challenges', () => {
  it('the fixture set exists and is stratified (regenerate with `npm run x402:coverage -- --fixture`)', () => {
    expect(manifest.length).toBeGreaterThanOrEqual(50)
    expect(new Set(manifest.map((m) => m.shape)).size).toBeGreaterThanOrEqual(8)
  })

  for (const row of manifest) {
    it(`${row.shape} → ${row.expect}: ${row.source.slice(0, 70)} (${row.why})`, async () => {
      const fx = JSON.parse(readFileSync(join(FIXTURES, row.file), 'utf8')) as Fixture

      // Bind to the rail the MANIFEST says this fixture is about — not merely the first one. Most
      // resources offer several chains, so an xrpl fixture that also co-offers Base would pass via
      // Base and prove nothing about XRPL.
      const rawNetwork = row.network
      // The client canonicalises slugs and the Algorand alias; the stub binds only the CANONICAL
      // id, so a v1-slug or spec-form-Algorand fixture passes only if that really happens in the SDK.
      const bound = rawNetwork.startsWith('algorand:')
        ? 'algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8='
        : { base: 'eip155:8453', solana: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', polygon: 'eip155:137', arbitrum: 'eip155:42161' }[rawNetwork] ?? rawNetwork
      // Only the rails ON THE BOUND NETWORK may contribute a recognised token, or a co-offered
      // rail's asset could make an off-chain rail look priceable.
      const assets = fx.accepts
        .filter((a) => String(a.network) === rawNetwork)
        .map((a) => String(a.asset))
        .filter((a) => a && a !== 'undefined')
      const stub = stubNetFor(bound, assets)
      registerDriver({ family: stub.family, resolve: () => stub })

      // The client must be bound to the fixture's OWN family. Binding EVM for every fixture let a
      // leftover EVM stub answer an XRPL fixture through a co-offered Base rail — the assertion
      // then measured the wrong chain entirely.
      const evm = /^eip155:(\d+)$/.exec(bound)
      const chain = evm
        ? { id: Number(evm[1]), rpcUrl: 'https://unused.invalid' }
        : ({ solana: 'solana', algorand: 'algorand', xrpl: 'xrpl', stellar: 'stellar', aptos: 'aptos', near: 'near', tvm: 'ton', tron: 'tron' }[bound.split(':')[0]!] ?? 'base')

      const url = fx.resource?.url ?? String(fx.accepts[0]!.resource ?? row.source)
      globalThis.fetch = (async () =>
        new Response(JSON.stringify(fx), { status: 402, headers: { 'content-type': 'application/json' } })) as typeof fetch

      const client = new PipRailClient({
        chain: chain as never,
        wallet: { key: '0x1' },
        schemes: ['onchain-proof', 'exact', 'upto'],
      })
      const plan = await client.planPayment(url)

      if (row.expect === 'payable') {
        expect(plan, `${row.file}: planPayment returned null`).not.toBeNull()
        expect(
          plan!.payable,
          `${row.shape}/${row.source} — expected payable, got ${plan!.status}` +
            ` (${plan!.options.length} option(s); ${plan!.fundingHint ?? 'no hint'})`
        ).toBe(true)
      } else {
        expect(plan?.payable ?? false, `${row.shape}/${row.source} — expected blocked, got payable`).toBe(false)
      }
    })
  }
})
