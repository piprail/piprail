/**
 * Receipts R1 + R2 — gate emission. R1: the `receipts` opt-in stamps a verifiable
 * `extensions['offer-receipt'].info` block + the CHALLENGE nonce onto the 200's
 * PAYMENT-RESPONSE header, the default (no option) 200 is byte-identical, the exact 200
 * carries NO nonce (digest-bound; never the per-rail auth nonce — close-out "Nonce
 * semantics"), `includeTxHash:false` writes `transaction:''` (§5.3), and a throwing
 * receipt builder degrades to the plain header (never a 500), isolated like `onPaid`.
 * R2: `receipts:{ attest:{ wallet } }` on an EVM gate signs a Tier-2 EIP-712 SignedReceipt
 * at the spec slot `info.receipt` (default tx present; false → signed+wire transaction ''); a
 * NON-EVM gate degrades to Tier-1 + a one-time warning (no throw, no attestation).
 * Companion to `server-exact.test.ts` / `server-onpaid.test.ts`.
 */
import { describe, it, expect, vi } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import { createWalletClient, http } from 'viem'
import { base } from 'viem/chains'
import { createPaymentGate } from '../src/server.js'
import { PipRailClient } from '../src/client.js'
import * as x402 from '../src/x402.js'
import { buildSignatureHeader, EXT_OFFER_RECEIPT } from '../src/x402.js'
import { proofAccepts } from './_dual-rail.js'
import { registerDriver } from '../src/drivers/index.js'
import type { PaymentDriver, WalletHandle } from '../src/drivers/types.js'
import { resolveExactRailEvm } from '../src/drivers/evm/exact.js'
import { signReceiptEvm } from '../src/drivers/evm/receipt.js'

// A fixed merchant key → the gate's payTo IS its address, so a Tier-2 attestation signed
// with it recovers === payTo (the spec §4.5.1 payTo-signing path).
const MERCHANT_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const
const merchantAccount = privateKeyToAccount(MERCHANT_KEY)
const PAY_TO = merchantAccount.address
const USDC = '0xusdc'

// Test knob: force the fake EVM driver's signReceipt to throw (signer-fault isolation test).
let signerShouldThrow = false

// A fake EVM driver: onchain-proof verify echoes the trusted accept; exact self-settle
// returns an `exact` receipt. No RPC. The exact receipt's tx is DISTINCT from the auth nonce.
const fakeEvm: PaymentDriver = {
  family: 'evm',
  resolve(opts) {
    const chain = opts.chain as { id?: number }
    if (typeof chain !== 'object' || typeof chain.id !== 'number') return null
    const network = `eip155:${chain.id}` as const
    return {
      family: 'evm',
      network,
      supports: (n) => n === network,
      resolveToken: (t) =>
        t === 'native'
          ? { asset: 'native', decimals: 18, symbol: 'ETH' }
          : { asset: USDC, decimals: 6, symbol: 'USDC' },
      describeAsset: () => ({ symbol: 'USDC', decimals: 6 }),
      assertValidPayTo: () => undefined,
      // A real viem adapter for a { key } wallet (so Tier-2 attestation signs for real);
      // any other shape passes through opaquely (the existing payment-path tests don't sign).
      bindWallet: (w) => {
        if (typeof w === 'object' && w !== null && 'key' in w) {
          const acct = privateKeyToAccount((w as { key: `0x${string}` }).key)
          const walletClient = createWalletClient({ account: acct, chain: base, transport: http('http://localhost:0') })
          return { _native: { account: acct, walletClient } }
        }
        return { _native: w }
      },
      send: async () => `0x${'1'.repeat(64)}`,
      confirm: async () => ({ height: '1' }),
      estimateCost: async () => ({ feeSymbol: 'ETH', feeDecimals: 18, fee: '0', feeFormatted: '0', basis: 'heuristic' as const }),
      balanceOf: async () => ({ token: 0n, native: 0n }),
      recipientReady: async () => ({ ready: 'n/a' as const }),
      verify: async (ref, accept) => ({
        ok: true,
        receipt: {
          scheme: 'onchain-proof', success: true, network: accept.network, transaction: ref,
          asset: accept.asset, amount: accept.amount, payer: '0xpayer', payTo: accept.payTo, verifiedAt: 'now',
        },
      }),
      exactPermit2Supported: () => false,
      exactDomain: async (asset) => (asset === USDC ? { name: 'USD Coin', version: '2' } : null),
      resolveExactRail: async ({ asset, method }) =>
        resolveExactRailEvm({
          asset, method,
          readDomain: async (a) => (a === USDC ? { name: 'USD Coin', version: '2' } : null),
          permit2Supported: () => false,
        }),
      settleExactSelf: async ({ payload, accept }) => ({
        ok: true,
        receipt: {
          scheme: 'exact', success: true, network: accept.network,
          // The SETTLE tx — deliberately NOT the auth nonce, to prove the receipt never stamps it.
          transaction: `0x${'fe'.repeat(32)}`,
          asset: accept.asset, amount: accept.amount,
          payer: 'authorization' in payload ? (payload.authorization as { from: string }).from : '0xpayer',
          payTo: accept.payTo, verifiedAt: 'now',
        },
      }),
      // Tier-2 attestation — real EIP-712 signing via the production EVM driver. A test knob
      // forces a signer fault to prove the gate isolates it (degrades to Tier-1, never a 500).
      signReceipt: (w: WalletHandle, input) => {
        if (signerShouldThrow) throw new Error('signer boom')
        return signReceiptEvm(w, input)
      },
    }
  },
}
registerDriver(fakeEvm)

// A NON-EVM fake (Solana) with NO signReceipt — so `attest` must degrade to Tier-1 + a warning.
const SOL_NET = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'
const fakeSolana: PaymentDriver = {
  family: 'solana',
  resolve(opts) {
    if (opts.chain !== 'solana') return null
    return {
      family: 'solana',
      network: SOL_NET as never,
      supports: (n) => n === SOL_NET,
      resolveToken: () => ({ asset: 'SoLusDcMint', decimals: 6, symbol: 'USDC' }),
      describeAsset: () => ({ symbol: 'USDC', decimals: 6 }),
      assertValidPayTo: () => undefined,
      bindWallet: (w) => ({ _native: w }),
      send: async () => 'sig',
      confirm: async () => ({ height: '1' }),
      estimateCost: async () => ({ feeSymbol: 'SOL', feeDecimals: 9, fee: '0', feeFormatted: '0', basis: 'heuristic' as const }),
      balanceOf: async () => ({ token: 0n, native: 0n }),
      recipientReady: async () => ({ ready: 'n/a' as const }),
      verify: async (ref, accept) => ({
        ok: true,
        receipt: {
          scheme: 'onchain-proof', success: true, network: accept.network, transaction: ref,
          asset: accept.asset, amount: accept.amount, payer: 'SoLpayer', payTo: accept.payTo, verifiedAt: 'now',
        },
      }),
      // NO signReceipt — the optional `?` is the EVM-only gate; `attest` degrades here.
    }
  },
}
registerDriver(fakeSolana)

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64')
const decode = (s: string) => JSON.parse(Buffer.from(s, 'base64').toString('utf8'))

function gateWith(opts: Partial<Parameters<typeof createPaymentGate>[0]> = {}) {
  return createPaymentGate({ chain: { id: 56, rpcUrl: 'x' }, token: 'USDC', amount: '0.05', payTo: PAY_TO, ...opts })
}

/** Drive one onchain-proof payment; returns { result, challengeNonce }. */
async function payProof(gate: ReturnType<typeof createPaymentGate>, tx = `0x${'c'.repeat(64)}`) {
  const { challenge } = await gate.challenge('https://api.example.com/r')
  const accept = proofAccepts(challenge)[0]!
  const challengeNonce = accept.extra.nonce
  const result = await gate.verify(
    buildSignatureHeader({ x402Version: 2, accepted: accept, payload: { nonce: challengeNonce, txHash: tx } })
  )
  return { result, challengeNonce }
}

/** Drive one exact (self-settle) payment with a KNOWN auth nonce; returns { result, authNonce }. */
async function payExact(gate: ReturnType<typeof createPaymentGate>) {
  const { challenge } = await gate.challenge('https://api.example.com/r')
  const exact = challenge.accepts.find((a) => a.scheme === 'exact')!
  const authNonce = `0x${'9'.repeat(64)}`
  const authorization = {
    from: '0x857b06519E91e3A54538791bDbb0E22373e36b66', to: PAY_TO, value: '50000',
    validAfter: '0', validBefore: '9999999999', nonce: authNonce,
  }
  const result = await gate.verify(b64({ x402Version: 2, accepted: exact, payload: { signature: '0xsig', authorization } }))
  return { result, authNonce }
}

describe('receipts · default (no option) is byte-identical', () => {
  it('the 200 PAYMENT-RESPONSE carries NO offer-receipt extension and NO nonce', async () => {
    const { result } = await payProof(gateWith())
    expect(result.kind).toBe('paid')
    if (result.kind !== 'paid') return
    const wire = decode(result.receiptHeader)
    expect('extensions' in wire).toBe(false)
    expect('nonce' in wire).toBe(false)
    expect(result.receipt.nonce).toBeUndefined()
  })
})

describe('receipts · onchain-proof 200 stamps the CHALLENGE nonce + offer-receipt block', () => {
  it('emits extensions[offer-receipt].info.receipt with the challenge nonce + resource + decimals', async () => {
    const gate = gateWith({ receipts: true, description: 'report' })
    const { result, challengeNonce } = await payProof(gate)
    expect(result.kind).toBe('paid')
    if (result.kind !== 'paid') return

    // The stamped receipt carries the CHALLENGE nonce (the trusted value the buyer echoed).
    expect(result.receipt.nonce).toBe(challengeNonce)

    const wire = decode(result.receiptHeader)
    const info = wire.extensions[EXT_OFFER_RECEIPT].info
    // PipRail's chain-grounded record at info.settlement (the spec's info.receipt is the SIGNED slot).
    expect(info.settlement.nonce).toBe(challengeNonce)
    expect(info.settlement.scheme).toBe('onchain-proof')
    expect(info.settlement.payTo).toBe(PAY_TO)
    expect(info.receipt).toBeUndefined() // Tier-1 (no attest) → no signed receipt at the spec slot
    expect(info.decimals).toBe(6)
    // resource.url is the gate-pinned value (default '' — the buyer's client fills the real URL).
    expect(info.resource.url).toBe('')
  })

  it('honors a gate-pinned resource URL', async () => {
    const gate = gateWith({ receipts: { resource: 'https://api.example.com/r' } })
    const { result } = await payProof(gate)
    if (result.kind !== 'paid') return
    expect(decode(result.receiptHeader).extensions[EXT_OFFER_RECEIPT].info.resource.url).toBe('https://api.example.com/r')
  })
})

describe('receipts · exact 200 emits a receipt with NO challenge nonce (never the auth nonce)', () => {
  it('the exact receipt omits nonce; the offer-receipt block is still present', async () => {
    const gate = gateWith({ chain: { id: 8453, rpcUrl: 'x' }, receipts: true, exact: { settle: 'self', relayer: { key: `0x${'ab'.repeat(32)}` } } })
    const { result, authNonce } = await payExact(gate)
    expect(result.kind).toBe('paid')
    if (result.kind !== 'paid') return

    // The exact rail is digest-bound — the receipt carries NO challenge nonce, and CRUCIALLY
    // it must never be the per-rail authorization nonce.
    expect(result.receipt.nonce).toBeUndefined()
    const wire = decode(result.receiptHeader)
    expect(wire.extensions[EXT_OFFER_RECEIPT].info.settlement.scheme).toBe('exact')
    expect(wire.extensions[EXT_OFFER_RECEIPT].info.settlement.nonce).toBeUndefined()
    expect(JSON.stringify(wire)).not.toContain(authNonce)
  })
})

describe('receipts · includeTxHash:false writes transaction:"" (§5.3), never a missing key', () => {
  it('suppresses the tx hash as the empty string on the wire receipt', async () => {
    const gate = gateWith({ receipts: { includeTxHash: false } })
    const { result } = await payProof(gate)
    if (result.kind !== 'paid') return
    expect(result.receipt.transaction).toBe('')
    const wire = decode(result.receiptHeader)
    expect(wire.transaction).toBe('')
    expect('transaction' in wire).toBe(true) // present, empty — not omitted
    expect(wire.extensions[EXT_OFFER_RECEIPT].info.settlement.transaction).toBe('')
  })
})

describe('receipts · a throwing receipt builder degrades to the plain header (never a 500)', () => {
  it('falls back to buildReceiptHeader(receipt) — no extension, still 200, isolated like onPaid', async () => {
    const spy = vi.spyOn(x402, 'buildReceiptExtension').mockImplementation(() => {
      throw new Error('boom')
    })
    try {
      const gate = gateWith({ receipts: true })
      const { result } = await payProof(gate)
      expect(result.kind).toBe('paid')
      if (result.kind !== 'paid') return
      const wire = decode(result.receiptHeader)
      // Degraded: the plain receipt header, no extension block, no crash.
      expect('extensions' in wire).toBe(false)
    } finally {
      spy.mockRestore()
    }
  })
})

/* ─────────────────────── R2 — Tier-2 EIP-712 attestation ─────────────────────── */

const ATTEST = { wallet: { key: MERCHANT_KEY } }

/** The signed-receipt block on a settled onchain-proof 200 (or null). It rides at the
 *  spec slot info.receipt (a stock @x402 reader reads it there). */
function attestationOn(receiptHeader: string) {
  const wire = decode(receiptHeader)
  return wire.extensions?.[EXT_OFFER_RECEIPT]?.info?.receipt ?? null
}

describe('receipts · R2 · EVM attest signs an EIP-712 delivery attestation (recover === payTo)', () => {
  it('the 200 carries the SignedReceipt at the spec slot info.receipt; includeTxHash defaults TRUE', async () => {
    const gate = gateWith({ receipts: { attest: ATTEST, resource: 'https://api.example.com/r' } })
    const { result } = await payProof(gate, `0x${'d'.repeat(64)}`)
    expect(result.kind).toBe('paid')
    if (result.kind !== 'paid') return

    const att = attestationOn(result.receiptHeader)
    expect(att).not.toBeNull()
    expect(att.format).toBe('eip712')
    expect(typeof att.signature).toBe('string')
    expect(att.signer.toLowerCase()).toBe(PAY_TO.toLowerCase())
    // Default includeTxHash:true → the SIGNED payload carries the real tx hash.
    expect(att.payload.transaction).toBe(`0x${'d'.repeat(64)}`)
    expect(att.payload.payer).toBe('0xpayer')
    expect(att.payload.resourceUrl).toBe('https://api.example.com/r')

    // The whole bundle re-verifies via the client (recover === payTo).
    const bundle = x402.parseReceiptExtension(
      new Response(null, { headers: { 'payment-response': result.receiptHeader } })
    )
    expect(bundle).not.toBeNull()
    const v = await PipRailClient.verifyAttestation(bundle!)
    expect(v.ok).toBe(true)
    expect(v.signer?.toLowerCase()).toBe(PAY_TO.toLowerCase())
  })

  it('includeTxHash:false → the SIGNED payload AND the wire receipt carry transaction:""', async () => {
    const gate = gateWith({ receipts: { attest: ATTEST, includeTxHash: false } })
    const { result } = await payProof(gate)
    if (result.kind !== 'paid') return
    const wire = decode(result.receiptHeader)
    // Wire receipt: suppressed tx is the empty string (§5.3), never a missing key.
    expect(wire.transaction).toBe('')
    expect(wire.extensions[EXT_OFFER_RECEIPT].info.settlement.transaction).toBe('')
    // Signed attestation payload: transaction is '' too (signed empty-string, never omitted).
    const att = wire.extensions[EXT_OFFER_RECEIPT].info.receipt
    expect(att.payload.transaction).toBe('')
    expect('transaction' in att.payload).toBe(true)
    // Still recovers payTo from the ''-message.
    const v = await PipRailClient.verifyAttestation(
      x402.parseReceiptExtension(new Response(null, { headers: { 'payment-response': result.receiptHeader } }))!
    )
    expect(v.ok).toBe(true)
  })
})

describe('receipts · R2 · a non-EVM gate with attest degrades to Tier-1 + a one-time warning', () => {
  it('emits NO attestation, still serves 200, warns once, never throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const gate = createPaymentGate({
        chain: 'solana', token: 'USDC', amount: '0.05', payTo: 'SoLmerchant',
        receipts: { attest: ATTEST },
      })
      const { result } = await payProof(gate)
      expect(result.kind).toBe('paid')
      if (result.kind !== 'paid') return
      // Tier-1 still emitted (the chain-grounded record is present)…
      const wire = decode(result.receiptHeader)
      expect(wire.extensions[EXT_OFFER_RECEIPT].info.settlement).toBeTruthy()
      // …but NO Tier-2 SignedReceipt at the spec slot on a non-EVM rail.
      expect(wire.extensions[EXT_OFFER_RECEIPT].info.receipt).toBeUndefined()
      // Warned (once) about the degrade — and no throw reached here.
      expect(warn).toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })
})

describe('receipts · R2 · a signing failure degrades to the unsigned Tier-1 receipt (never a 500)', () => {
  it('a throwing signReceipt falls back to Tier-1 + warns, still 200', async () => {
    // Force the signer to throw — the gate must isolate it like onPaid (degrade, never 500).
    signerShouldThrow = true
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const gate = gateWith({ receipts: { attest: ATTEST } })
      const { result } = await payProof(gate)
      expect(result.kind).toBe('paid')
      if (result.kind !== 'paid') return
      const wire = decode(result.receiptHeader)
      // Tier-1 settlement record present, but no signed receipt (signing degraded), no crash.
      expect(wire.extensions[EXT_OFFER_RECEIPT].info.settlement).toBeTruthy()
      expect(wire.extensions[EXT_OFFER_RECEIPT].info.receipt).toBeUndefined()
    } finally {
      signerShouldThrow = false
      warn.mockRestore()
    }
  })
})
