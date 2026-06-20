/**
 * The buyer-side `upto` (metered) rail wired into PipRailClient (opt-in `schemes`). Drives a
 * FAKE evm driver (with `payUpto` + `describeAsset`) so no real chain/RPC is touched. Pins the
 * scheme gating (OFF by default), the conservative pay path, BUDGET-AGAINST-THE-MAX, and the
 * merchant-proof ledger seam: the cap-bearing amount IS the authorized MAX (an under-reporting
 * merchant can't slip a cumulative leash, POL-1), with the settled actual surfaced on settledBase.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import {
  PipRailClient,
  registerDriver,
  buildChallengeHeader,
  NoCompatibleAcceptError,
  PaymentDeclinedError,
  type ResolvedNetwork,
  type X402UptoAcceptEntry,
  type Permit2UptoPaymentPayload,
} from '../src/index.js'

const NET = 'eip155:8453'
const URL = 'https://api.example.com/llm'
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const UNKNOWN = '0x00000000000000000000000000000000000000ff'
const PAYTO = '0x1111111111111111111111111111111111111111'
const FACILITATOR = '0x2222222222222222222222222222222222222222'

let payUptoCalls = 0
let nonceCtr = 0
beforeEach(() => { payUptoCalls = 0; nonceCtr = 0 })

function makeNet(opts: { withUpto?: boolean } = {}): ResolvedNetwork {
  const withUpto = opts.withUpto ?? true
  const net: ResolvedNetwork = {
    family: 'evm',
    network: NET,
    supports: (n) => n === NET,
    resolveToken: () => ({ asset: USDC, decimals: 6, symbol: 'USDC' }),
    describeAsset: (a) => (a === USDC ? { symbol: 'USDC', decimals: 6 } : null),
    assertValidPayTo: () => undefined,
    bindWallet: (w) => ({ _native: w }),
    send: async () => '0xONCHAINPROOFTX',
    confirm: async () => ({ height: '100' }),
    estimateCost: async () => ({ feeSymbol: 'ETH', feeDecimals: 18, fee: '0', feeFormatted: '0', basis: 'estimated' as const }),
    balanceOf: async () => ({ token: 100_000_000n, native: 1_000_000_000_000_000_000n }),
    recipientReady: async () => ({ ready: 'n/a' as const }),
    verify: async () => ({ ok: false, error: 'transfer_not_found', detail: 'unused client-side' }),
  }
  if (withUpto) {
    net.payUpto = async (_w, accept) => {
      payUptoCalls += 1
      nonceCtr += 1
      const nonce = String(nonceCtr) + '000000'
      const payload: Permit2UptoPaymentPayload = {
        signature: `0x${'cd'.repeat(65)}`,
        permit2Authorization: {
          permitted: { token: accept.asset, amount: accept.amount }, // signs the MAX
          from: '0xPAYER',
          spender: '0x4020A4f3b7b90ccA423B9fabCc0CE57C6C240002',
          nonce,
          deadline: '9999999999',
          witness: { to: accept.payTo, facilitator: accept.extra.facilitatorAddress, validAfter: '0' },
        },
      }
      return { payload, accepted: accept, payerFrom: '0xPAYER', nonce }
    }
  }
  return net
}

let net = makeNet()
registerDriver({ family: 'evm', resolve: () => net })

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch; net = makeNet() })

function uptoAccept(over: Partial<X402UptoAcceptEntry> = {}): X402UptoAcceptEntry {
  return {
    scheme: 'upto',
    network: NET,
    amount: '500000', // the MAX = 0.50 USDC @ 6dp
    asset: USDC,
    payTo: PAYTO,
    maxTimeoutSeconds: 300,
    extra: { assetTransferMethod: 'permit2-upto', facilitatorAddress: FACILITATOR, decimals: 6, symbol: 'USDC' },
    ...over,
  }
}
function onchainAccept() {
  return { scheme: 'onchain-proof', network: NET, amount: '500000', asset: USDC, payTo: PAYTO, maxTimeoutSeconds: 600, extra: { nonce: 'n1', decimals: 6, minConfirmations: 1, amountFormatted: '0.50', symbol: 'USDC' } }
}

/** Stub fetch: 402 (challenge) for a proof-less request, else `onProof(sigHeader)`. */
function stub(accepts: unknown[], onProof: (sig: string) => Response | Promise<Response>) {
  globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
    const sig = new Headers(init?.headers ?? {}).get('payment-signature')
    if (!sig) {
      const body = { x402Version: 2 as const, error: null, resource: { url: URL }, accepts }
      return new Response(JSON.stringify(body), { status: 402, headers: { 'payment-required': buildChallengeHeader(body as never) } })
    }
    return onProof(sig)
  }) as typeof fetch
}

/** A 200 with a SettleResponse carrying the ACTUAL settled `amount` (the upto field). */
const settle200 = (over: { transaction?: string; amount?: string } = {}) =>
  new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'payment-response': Buffer.from(JSON.stringify({ success: true, transaction: over.transaction ?? '0xSETTLE', network: NET, payer: '0xPAYER', ...(over.amount !== undefined ? { amount: over.amount } : {}) }), 'utf8').toString('base64') },
  })

describe('upto schemes gating — OFF by default', () => {
  it('a DEFAULT client on an upto-only challenge → NoCompatibleAcceptError (enable-it message)', async () => {
    stub([uptoAccept()], () => settle200())
    const client = new PipRailClient({ chain: 'base', wallet: { key: '0x1' } })
    await expect(client.fetch(URL)).rejects.toBeInstanceOf(NoCompatibleAcceptError)
    expect(payUptoCalls).toBe(0)
  })

  it('schemes:["upto"] pays the metered rail: signs ONCE the MAX, v2 PAYMENT-SIGNATURE, no broadcast', async () => {
    let sentSig = ''
    stub([uptoAccept()], (sig) => { sentSig = sig; return settle200({ amount: '120000' }) })
    const client = new PipRailClient({ chain: 'base', wallet: { key: '0x1' }, schemes: ['upto'] })
    const res = await client.fetch(URL)
    expect(res.status).toBe(200)
    expect(payUptoCalls).toBe(1)
    const decoded = JSON.parse(Buffer.from(sentSig, 'base64').toString('utf8'))
    expect(decoded.accepted.scheme).toBe('upto')
    // The buyer signs the MAX (500000), and binds witness.facilitator from extra.facilitatorAddress.
    expect(decoded.payload.permit2Authorization.permitted.amount).toBe('500000')
    expect(decoded.payload.permit2Authorization.witness.facilitator).toBe(FACILITATOR)
  })

  it('per-call fetch(url,{schemes:["upto"]}) overrides — and does NOT leak into later calls', async () => {
    stub([uptoAccept()], () => settle200({ amount: '100000' }))
    const client = new PipRailClient({ chain: 'base', wallet: { key: '0x1' } })
    const res = await client.fetch(URL, { schemes: ['upto'] })
    expect(res.status).toBe(200)
    await expect(client.fetch(URL)).rejects.toBeInstanceOf(NoCompatibleAcceptError)
  })

  it('upto rail on an UNRECOGNISED token is not gathered → NoCompatibleAcceptError', async () => {
    stub([uptoAccept({ asset: UNKNOWN })], () => settle200())
    const client = new PipRailClient({ chain: 'base', wallet: { key: '0x1' }, schemes: ['upto'] })
    await expect(client.fetch(URL)).rejects.toBeInstanceOf(NoCompatibleAcceptError)
  })

  it('upto rail with NO facilitatorAddress is not gathered (nothing to bind) → NoCompatibleAcceptError', async () => {
    stub([uptoAccept({ extra: { assetTransferMethod: 'permit2-upto', facilitatorAddress: '', decimals: 6 } })], () => settle200())
    const client = new PipRailClient({ chain: 'base', wallet: { key: '0x1' }, schemes: ['upto'] })
    await expect(client.fetch(URL)).rejects.toBeInstanceOf(NoCompatibleAcceptError)
  })
})

describe('upto — budget AGAINST THE MAX (the overcharge guard)', () => {
  it('the policy cap gates on the MAX (the server MAY charge up to it), refusing BEFORE signing', async () => {
    stub([uptoAccept()], () => settle200({ amount: '1' }))
    // maxAmount 0.10 < the rail MAX of 0.50 → declined before any signature, even though the
    // server would only have charged 0.000001.
    const client = new PipRailClient({ chain: 'base', wallet: { key: '0x1' }, schemes: ['upto'], policy: { maxAmount: '0.10' } })
    await expect(client.fetch(URL)).rejects.toBeInstanceOf(PaymentDeclinedError)
    expect(payUptoCalls).toBe(0) // never signed — the budget gate fired pre-signature
  })

  it('a MAX within budget is paid', async () => {
    stub([uptoAccept()], () => settle200({ amount: '100000' }))
    const client = new PipRailClient({ chain: 'base', wallet: { key: '0x1' }, schemes: ['upto'], policy: { maxAmount: '1.00' } })
    const res = await client.fetch(URL)
    expect(res.status).toBe(200)
    expect(payUptoCalls).toBe(1)
  })
})

describe('upto — the ledger budgets the MAX (merchant-proof), and surfaces the settled ACTUAL', () => {
  it('budgets the authorized MAX (amountBase) but records the settled ACTUAL on settledBase/Formatted', async () => {
    stub([uptoAccept()], () => settle200({ transaction: '0xMETERED', amount: '120000' }))
    const client = new PipRailClient({ chain: 'base', wallet: { key: '0x1' }, schemes: ['upto'] })
    await client.fetch(URL)
    const spend = client.spent()
    expect(spend.count).toBe(1)
    expect(spend.records[0]!.ref).toBe('0xMETERED')
    // The cap-bearing figure is the authorized MAX — a merchant cannot loosen a budget by
    // under-reporting the actual (POL-1). The cumulative tally uses this, so byAsset === MAX.
    expect(spend.records[0]!.amountBase).toBe('500000') // the MAX, NOT the 120000 actual
    expect(spend.records[0]!.amountFormatted).toBe('0.5')
    expect(spend.byAsset[0]!.totalBase).toBe('500000')
    // The merchant-claimed settled actual is surfaced for transparency (it equals the receipt's).
    expect(spend.records[0]!.settledBase).toBe('120000')
    expect(spend.records[0]!.settledFormatted).toBe('0.12')
  })

  it('a malicious UNDER-REPORT cannot slip the cumulative leash — the cap still debits the MAX', async () => {
    // Merchant settles up to the MAX on-chain but reports amount:"1". The budget must still
    // debit the authorized MAX, so a maxTotal leash holds against the true on-chain exposure.
    stub([uptoAccept()], () => settle200({ transaction: '0xUNDER', amount: '1' }))
    const client = new PipRailClient({ chain: 'base', wallet: { key: '0x1' }, schemes: ['upto'] })
    await client.fetch(URL)
    const spend = client.spent()
    expect(spend.records[0]!.amountBase).toBe('500000') // MAX debited — leash-safe
    expect(spend.records[0]!.settledBase).toBe('1') // the claimed actual, surfaced only
    expect(spend.byAsset[0]!.totalBase).toBe('500000')
  })

  it('clamps a hostile OVER-report of the actual to the MAX (settledBase never exceeds amountBase)', async () => {
    // A server claiming an actual ABOVE the signed max cannot inflate even the informational figure.
    stub([uptoAccept()], () => settle200({ transaction: '0xOVER', amount: '999999999' }))
    const client = new PipRailClient({ chain: 'base', wallet: { key: '0x1' }, schemes: ['upto'] })
    await client.fetch(URL)
    const spend = client.spent()
    expect(spend.records[0]!.amountBase).toBe('500000')
    expect(spend.records[0]!.settledBase).toBe('500000') // clamped to the MAX
  })

  it('a $0 metered settle budgets the MAX but surfaces settledBase "0" (ref falls through to nonce)', async () => {
    stub([uptoAccept()], () => settle200({ transaction: '', amount: '0' }))
    const client = new PipRailClient({ chain: 'base', wallet: { key: '0x1' }, schemes: ['upto'] })
    await client.fetch(URL)
    const spend = client.spent()
    expect(spend.count).toBe(1)
    expect(spend.records[0]!.amountBase).toBe('500000') // MAX budgeted
    expect(spend.records[0]!.settledBase).toBe('0') // a true zero-charge, surfaced
    expect(spend.records[0]!.ref).toMatch(/^upto-nonce:/) // transaction:"" → nonce ref for the audit trail
  })

  it('a non-conformant server that OMITS settle.amount budgets the MAX with no settledBase', async () => {
    stub([uptoAccept()], () => settle200({ transaction: '0xNOAMOUNT' }))
    const client = new PipRailClient({ chain: 'base', wallet: { key: '0x1' }, schemes: ['upto'] })
    await client.fetch(URL)
    const spend = client.spent()
    expect(spend.records[0]!.amountBase).toBe('500000') // the MAX
    expect(spend.records[0]!.settledBase).toBeUndefined() // no actual to surface
  })
})

describe('upto — dual-rail selection (onchain-proof preferred when both enabled)', () => {
  it('mixed [onchain-proof, upto] with both schemes on → pays ONCHAIN-PROOF (bucket order), not upto', async () => {
    stub([onchainAccept(), uptoAccept()], () => settle200())
    const client = new PipRailClient({ chain: 'base', wallet: { key: '0x1' }, schemes: ['onchain-proof', 'upto'] })
    const res = await client.fetch(URL)
    expect(res.status).toBe(200)
    expect(payUptoCalls).toBe(0) // onchain-proof won the bucket order
  })

  it('a family without payUpto on an upto-only challenge → NoCompatibleAcceptError', async () => {
    net = makeNet({ withUpto: false })
    stub([uptoAccept()], () => settle200())
    const client = new PipRailClient({ chain: 'base', wallet: { key: '0x1' }, schemes: ['upto'] })
    await expect(client.fetch(URL)).rejects.toBeInstanceOf(NoCompatibleAcceptError)
  })
})
