/**
 * Receipts R1 — the `PipRailClient.verifyReceipt` keystone. Re-verifies a PipRailReceipt
 * against the chain via a FAKE family driver (no RPC), proving the close-out B10 sub-defects:
 *   B10a — `amount` is a verified LOWER BOUND (tx moved ≥ claim → ok; claim above actual →
 *          amount_too_low); `onChain.payer` is re-derived (forged claimed payer → matchesClaims:false).
 *   B10b — NEAR ref is reconstructed `<payer>:<tx>` (the fake NEAR driver asserts the composite ref).
 *   B10c — `receipt.decimals` threads into the synthetic accept's `extra.decimals` (6 fallback).
 *   B10d — durable for digest-bound (far-past verifiedAt still ok); account-watch scan-miss →
 *          transfer_not_found with ageSeconds still reported.
 * Plus Template-A nonce (missing memo nonce → unverifiable) and never-throws (driver throw → ok:false).
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import { createWalletClient, http } from 'viem'
import { base } from 'viem/chains'
import { PipRailClient } from '../src/client.js'
import { registerDriver } from '../src/drivers/index.js'
import { signReceiptEvm } from '../src/drivers/evm/receipt.js'
import type { PaymentDriver, WalletHandle } from '../src/drivers/types.js'
import type { PipRailReceipt, X402Receipt, SignedReceipt } from '../src/x402.js'

// Mutable knobs the fake drivers read, so each test drives the same verify() differently.
const state = {
  movedAmount: '50000', // what the tx ACTUALLY moved on-chain
  txPayer: '0xrealpayer', // the genuinely re-derived sender
  requireNonce: false, // Template-A: fail when the synthetic accept carries no memo nonce
  scanMiss: false, // account-watch family: tx is beyond the merchant-history scan window
  throwOnVerify: false, // simulate an RPC blip → verifyReceipt must catch, never throw
  lastRef: '', // the ref verify() received (NEAR composite-ref assertion)
  lastDecimals: -1, // accept.extra.decimals verify() received (B10c threading assertion)
}
beforeEach(() => {
  state.movedAmount = '50000'
  state.txPayer = '0xrealpayer'
  state.requireNonce = false
  state.scanMiss = false
  state.throwOnVerify = false
  state.lastRef = ''
  state.lastDecimals = -1
})

function makeFake(family: PaymentDriver['family'], network: string, accepts: (chain: unknown) => boolean): PaymentDriver {
  return {
    family,
    resolve(opts) {
      // Faithful to a real driver: reject a chain selector this family doesn't recognise
      // (so an unknown CAIP-2 namespace that falls back to 'evm' resolves to null → ok:false).
      if (!accepts(opts.chain)) return null
      return {
        family,
        network: network as never,
        supports: (n) => n === network,
        resolveToken: () => ({ asset: 'x', decimals: 6, symbol: 'X' }),
        describeAsset: () => ({ symbol: 'X', decimals: 6 }),
        assertValidPayTo: () => undefined,
        bindWallet: (w) => ({ _native: w }),
        send: async () => 'tx',
        confirm: async () => ({ height: '1' }),
        estimateCost: async () => ({ feeSymbol: 'X', feeDecimals: 6, fee: '0', feeFormatted: '0', basis: 'heuristic' as const }),
        balanceOf: async () => ({ token: 0n, native: 0n }),
        recipientReady: async () => ({ ready: 'n/a' as const }),
        verify: async (ref: string, accept) => {
          state.lastRef = ref
          state.lastDecimals = accept.extra.decimals
          if (state.throwOnVerify) throw new Error('RPC down')
          if (state.scanMiss) return { ok: false as const, error: 'transfer_not_found' as const, detail: 'beyond scan window' }
          if (state.requireNonce && !accept.extra.nonce) return { ok: false as const, error: 'transfer_not_found' as const, detail: 'memo nonce missing' }
          if (BigInt(state.movedAmount) < BigInt(accept.amount)) return { ok: false as const, error: 'amount_too_low' as const, detail: 'tx moved less than claimed' }
          return {
            ok: true as const,
            receipt: {
              scheme: 'onchain-proof' as const, success: true as const, network: accept.network,
              transaction: ref, asset: accept.asset, amount: accept.amount,
              payer: state.txPayer, payTo: accept.payTo, verifiedAt: 'now',
            },
          }
        },
      }
    },
  }
}
registerDriver(makeFake('evm', 'eip155:8453', (c) => c === 'base' || (typeof c === 'object' && c !== null && (c as { id?: number }).id === 8453)))
registerDriver(makeFake('near', 'near:mainnet', (c) => c === 'near'))
registerDriver(makeFake('stellar', 'stellar:pubnet', (c) => c === 'stellar'))

function receipt(over: Partial<X402Receipt> = {}, bundle: Partial<PipRailReceipt> = {}): PipRailReceipt {
  const r: X402Receipt = {
    scheme: 'onchain-proof', success: true, network: 'eip155:8453',
    transaction: `0x${'ab'.repeat(32)}`, asset: '0xusdc', amount: '50000',
    payer: '0xrealpayer', payTo: '0xmerchant', verifiedAt: new Date().toISOString(), ...over,
  }
  return { piprail: '1', receipt: r, resource: { url: 'https://x.test/r' }, decimals: 6, ...bundle }
}

describe('verifyReceipt · B10a — amount is a verified LOWER BOUND; payer is re-derived', () => {
  it('ok:true when the tx moved EXACTLY the claimed amount, matchesClaims:true', async () => {
    const v = await PipRailClient.verifyReceipt(receipt())
    expect(v.ok).toBe(true)
    expect(v.matchesClaims).toBe(true)
    expect(v.onChain.payer).toBe('0xrealpayer')
  })

  it('ok:true when the tx moved MORE than claimed (lower-bound semantics)', async () => {
    state.movedAmount = '90000'
    const v = await PipRailClient.verifyReceipt(receipt({ amount: '50000' }))
    expect(v.ok).toBe(true)
  })

  it('amount_too_low only when the claim is ABOVE what actually moved', async () => {
    state.movedAmount = '40000'
    const v = await PipRailClient.verifyReceipt(receipt({ amount: '50000' }))
    expect(v.ok).toBe(false)
    expect(v.error).toBe('amount_too_low')
  })

  it('onChain.payer reflects the tx sender even when the receipt FORGES payer (matchesClaims:false)', async () => {
    state.txPayer = '0xrealpayer'
    const v = await PipRailClient.verifyReceipt(receipt({ payer: '0xFORGED' }))
    expect(v.ok).toBe(true) // the payment is real…
    expect(v.onChain.payer).toBe('0xrealpayer') // …re-derived from the tx…
    expect(v.matchesClaims).toBe(false) // …but the forged claim is caught.
  })
})

describe('verifyReceipt · B10b — NEAR ref is reconstructed <payer>:<tx>', () => {
  it('passes the composite ref to the NEAR driver, not the bare hash', async () => {
    const v = await PipRailClient.verifyReceipt(
      receipt({ network: 'near:mainnet', payer: 'alice.near', transaction: 'NEARHASH123' })
    )
    expect(v.ok).toBe(true)
    expect(state.lastRef).toBe('alice.near:NEARHASH123')
  })

  it('a NON-near family passes the bare transaction ref', async () => {
    await PipRailClient.verifyReceipt(receipt({ transaction: '0xBARE' }))
    expect(state.lastRef).toBe('0xBARE')
  })
})

describe('verifyReceipt · B10c — decimals threads into the synthetic accept', () => {
  it('uses receipt.decimals when present', async () => {
    await PipRailClient.verifyReceipt(receipt({ network: 'stellar:pubnet' }, { decimals: 7 }))
    expect(state.lastDecimals).toBe(7)
  })

  it('falls back to 6 when the receipt omits decimals (no crash, asserts the verdict)', async () => {
    const r = receipt({ network: 'stellar:pubnet' })
    delete (r as { decimals?: number }).decimals
    const v = await PipRailClient.verifyReceipt(r)
    expect(state.lastDecimals).toBe(6)
    expect(v.ok).toBe(true)
  })
})

describe('verifyReceipt · Template-A nonce — a missing memo nonce makes it unverifiable', () => {
  it('verifies when the receipt carries the challenge nonce', async () => {
    state.requireNonce = true
    const v = await PipRailClient.verifyReceipt(receipt({ network: 'stellar:pubnet', nonce: 'memo-nonce-1' }))
    expect(v.ok).toBe(true)
  })

  it('fails (transfer_not_found) when the nonce is absent', async () => {
    state.requireNonce = true
    const v = await PipRailClient.verifyReceipt(receipt({ network: 'stellar:pubnet' })) // no nonce
    expect(v.ok).toBe(false)
    expect(v.error).toBe('transfer_not_found')
  })
})

describe('verifyReceipt · B10d — durability split', () => {
  it('digest-bound: a far-past verifiedAt still re-verifies ok, ageSeconds reported', async () => {
    const v = await PipRailClient.verifyReceipt(receipt({ verifiedAt: '2020-01-01T00:00:00.000Z' }))
    expect(v.ok).toBe(true)
    expect(v.ageSeconds).toBeGreaterThan(60 * 60 * 24 * 365) // > a year old, still valid
  })

  it('account-watch: a tx beyond the scan window → transfer_not_found, ageSeconds still reported', async () => {
    state.scanMiss = true
    const v = await PipRailClient.verifyReceipt(receipt({ network: 'stellar:pubnet', verifiedAt: '2020-01-01T00:00:00.000Z' }))
    expect(v.ok).toBe(false)
    expect(v.error).toBe('transfer_not_found')
    expect(v.ageSeconds).toBeGreaterThan(0)
  })
})

describe('verifyReceipt · never throws', () => {
  it('a driver/RPC throw → { ok:false } (ERRORS.md), not an exception', async () => {
    state.throwOnVerify = true
    const v = await PipRailClient.verifyReceipt(receipt())
    expect(v.ok).toBe(false)
    expect(v.error).toBe('tx_not_found')
  })

  it('an unknown / unmounted network → { ok:false }, never a throw', async () => {
    const v = await PipRailClient.verifyReceipt(receipt({ network: 'doge:1' }))
    expect(v.ok).toBe(false)
  })

  it('a MALFORMED receipt bundle (no inner .receipt, or null) → { ok:false }, never a throw', async () => {
    // The MCP tool hands verifyReceipt whatever the model passes — it must degrade, not throw.
    for (const bad of [{ piprail: '1' } as unknown, null as unknown, undefined as unknown, 42 as unknown]) {
      const v = await PipRailClient.verifyReceipt(bad as never)
      expect(v.ok).toBe(false)
      expect(v.matchesClaims).toBe(false)
    }
  })
})

/* ─────────────────────── R2 — verifyAttestation (Tier-2) ─────────────────────── */

const MERCHANT_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const
const merchant = privateKeyToAccount(MERCHANT_KEY)
const MERCHANT = merchant.address

function merchantWallet(): WalletHandle {
  const walletClient = createWalletClient({ account: merchant, chain: base, transport: http('http://localhost:0') })
  return { _native: { account: merchant, walletClient } }
}

/** A PipRailReceipt with a REAL Tier-2 attestation signed by `payTo`'s key. */
async function attestedReceipt(over: Partial<X402Receipt> = {}): Promise<PipRailReceipt> {
  const r: X402Receipt = {
    scheme: 'onchain-proof', success: true, network: 'eip155:8453',
    transaction: `0x${'ab'.repeat(32)}`, asset: '0xusdc', amount: '50000',
    payer: '0xrealpayer', payTo: MERCHANT, verifiedAt: '2024-01-01T00:00:00.000Z', ...over,
  }
  const attestation = await signReceiptEvm(merchantWallet(), {
    payTo: r.payTo, network: r.network, resourceUrl: 'https://x.test/r',
    payer: r.payer, issuedAt: Math.floor(Date.parse(r.verifiedAt) / 1000), transaction: r.transaction,
  })
  return { piprail: '1', receipt: r, resource: { url: 'https://x.test/r' }, decimals: 6, attestation }
}

describe('verifyAttestation · R2 — EVM recover === payTo', () => {
  it('{ ok:true, signer } for a payTo-signed receipt', async () => {
    const v = await PipRailClient.verifyAttestation(await attestedReceipt())
    expect(v.ok).toBe(true)
    expect(v.signer?.toLowerCase()).toBe(MERCHANT.toLowerCase())
  })

  it('{ ok:false } when recover !== payTo (the receipt claims a different merchant)', async () => {
    const bundle = await attestedReceipt()
    // Forge the claimed payTo to a different address — recovery no longer matches.
    bundle.receipt.payTo = '0x1111111111111111111111111111111111111111'
    const v = await PipRailClient.verifyAttestation(bundle)
    expect(v.ok).toBe(false)
    expect(v.reason).toBe('signer-mismatch')
  })

  it('{ ok:false } when the signed payload is tampered after signing', async () => {
    const bundle = await attestedReceipt()
    // Mutate the signed payload's payer — the recovered signer changes → mismatch.
    const att = bundle.attestation as unknown as { payload: Record<string, unknown> }
    att.payload = { ...att.payload, payer: '0xTAMPERED' }
    const v = await PipRailClient.verifyAttestation(bundle)
    expect(v.ok).toBe(false)
  })
})

describe('verifyAttestation · R2 — never throws on malformed/absent input', () => {
  it('a receipt with NO attestation → { ok:false, reason:"no-attestation" }', async () => {
    const v = await PipRailClient.verifyAttestation(receipt())
    expect(v.ok).toBe(false)
    expect(v.reason).toBe('no-attestation')
  })

  it('a JWS-format attestation defers to R3 → { ok:false, reason:"jws-not-loaded" }', async () => {
    const bundle = receipt()
    bundle.attestation = { format: 'jws', signature: 'eyJ...', signer: MERCHANT } as unknown as SignedReceipt
    const v = await PipRailClient.verifyAttestation(bundle)
    expect(v.ok).toBe(false)
    expect(v.reason).toBe('jws-not-loaded')
  })

  it('a garbage signature → { ok:false }, never a throw', async () => {
    const bundle = receipt()
    bundle.attestation = { format: 'eip712', signature: '0xdeadbeef', signer: MERCHANT } as unknown as SignedReceipt
    const v = await PipRailClient.verifyAttestation(bundle)
    expect(v.ok).toBe(false)
  })

  it('a totally malformed bundle → { ok:false }, never a throw', async () => {
    for (const bad of [null, undefined, 42, { piprail: '1' }]) {
      const v = await PipRailClient.verifyAttestation(bad as never)
      expect(v.ok).toBe(false)
    }
  })
})
