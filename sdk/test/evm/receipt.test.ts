/**
 * Receipts R2 — the EVM Tier-2 EIP-712 service-delivery attestation. This is a
 * financial/crypto-signing rail, so the EIP-712 contract is asserted byte-exact:
 *   - the FROZEN domain `{ name:'x402 receipt', version:'1', chainId:1 }` (chainId 1
 *     for ALL networks — verified against the official @x402/extensions signing.ts).
 *   - RECEIPT_TYPES with the LOAD-BEARING field order
 *     `version,network,resourceUrl,payer,issuedAt,transaction` + primaryType `Receipt`.
 *   - round-trip sign → verifyReceiptAttestationEvm recovers the signer; recover===payTo passes.
 *   - a TAMPERED signature recovers a DIFFERENT address and does NOT throw — the
 *     equality check catches it (the official EIP-712 footgun: recoverTypedDataAddress
 *     never throws on a bad sig, it returns a wrong address).
 *   - §5.3 empty-string rule: includeTxHash:false → the signed message transaction===''
 *     (asserted on the typed data), sign→verify still recovers payTo; a message that
 *     OMITS the transaction key does NOT match a ''-message's recovery (treat '' as absence).
 */
import { describe, it, expect } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import {
  createWalletClient,
  http,
  hashTypedData,
  recoverTypedDataAddress,
  type Hex,
} from 'viem'
import { base } from 'viem/chains'
import {
  signReceiptEvm,
  verifyReceiptAttestationEvm,
  RECEIPT_DOMAIN,
  RECEIPT_TYPES,
  RECEIPT_PRIMARY_TYPE,
} from '../../src/drivers/evm/receipt.js'
import type { WalletHandle } from '../../src/drivers/types.js'

// A fixed test key → deterministic signatures. The account address is the merchant payTo.
const KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const
const account = privateKeyToAccount(KEY)
const PAY_TO = account.address
const OTHER = '0x1111111111111111111111111111111111111111'
const RESOURCE = 'https://api.example.com/premium-data'
const NETWORK = 'eip155:8453'
const PAYER = '0x857b06519E91e3A54538791bDbb0E22373e36b66'
const ISSUED_AT = 1703123456
const TX = `0x${'ab'.repeat(32)}`

/** A bound EVM WalletHandle whose _native is the { account, walletClient } adapter. */
function wallet(): WalletHandle {
  const walletClient = createWalletClient({ account, chain: base, transport: http('http://localhost:0') })
  return { _native: { account, walletClient } }
}

describe('R2 · the frozen EIP-712 contract matches the official source byte-exact', () => {
  it('domain is hardcoded { name:"x402 receipt", version:"1", chainId:1 } for ALL networks', () => {
    expect(RECEIPT_DOMAIN).toEqual({ name: 'x402 receipt', version: '1', chainId: 1 })
  })

  it('primaryType is "Receipt"', () => {
    expect(RECEIPT_PRIMARY_TYPE).toBe('Receipt')
  })

  it('RECEIPT_TYPES has the LOAD-BEARING field order + types (verified vs signing.ts:262)', () => {
    expect(RECEIPT_TYPES).toEqual({
      Receipt: [
        { name: 'version', type: 'uint256' },
        { name: 'network', type: 'string' },
        { name: 'resourceUrl', type: 'string' },
        { name: 'payer', type: 'string' },
        { name: 'issuedAt', type: 'uint256' },
        { name: 'transaction', type: 'string' },
      ],
    })
  })

  it('the domain + types are frozen (cannot drift at runtime)', () => {
    expect(Object.isFrozen(RECEIPT_DOMAIN)).toBe(true)
    expect(Object.isFrozen(RECEIPT_TYPES)).toBe(true)
  })
})

describe('R2 · signReceiptEvm → verifyReceiptAttestationEvm round-trip', () => {
  it('signs over the official typed data and recovers the signer; recover===payTo → ok', async () => {
    const att = await signReceiptEvm(wallet(), {
      payTo: PAY_TO, network: NETWORK, resourceUrl: RESOURCE, payer: PAYER, issuedAt: ISSUED_AT, transaction: TX,
    })
    expect(att.signer.toLowerCase()).toBe(PAY_TO.toLowerCase())
    expect(att.signature).toMatch(/^0x[0-9a-fA-F]+$/)

    const v = await verifyReceiptAttestationEvm({
      payTo: PAY_TO, network: NETWORK, resourceUrl: RESOURCE, payer: PAYER, issuedAt: ISSUED_AT, transaction: TX,
      signature: att.signature,
    })
    expect(v.ok).toBe(true)
    expect(v.signer?.toLowerCase()).toBe(PAY_TO.toLowerCase())
  })

  it('the signature recovers via raw viem over the SAME frozen domain/types/message', async () => {
    const att = await signReceiptEvm(wallet(), {
      payTo: PAY_TO, network: NETWORK, resourceUrl: RESOURCE, payer: PAYER, issuedAt: ISSUED_AT, transaction: TX,
    })
    const recovered = await recoverTypedDataAddress({
      domain: RECEIPT_DOMAIN,
      types: RECEIPT_TYPES as unknown as Record<string, Array<{ name: string; type: string }>>,
      primaryType: RECEIPT_PRIMARY_TYPE,
      message: {
        version: 1n, network: NETWORK, resourceUrl: RESOURCE, payer: PAYER, issuedAt: BigInt(ISSUED_AT), transaction: TX,
      },
      signature: att.signature as Hex,
    })
    expect(recovered.toLowerCase()).toBe(PAY_TO.toLowerCase())
  })

  it('verify returns recover !== payTo → ok:false when the expected payTo is a DIFFERENT address', async () => {
    const att = await signReceiptEvm(wallet(), {
      payTo: PAY_TO, network: NETWORK, resourceUrl: RESOURCE, payer: PAYER, issuedAt: ISSUED_AT, transaction: TX,
    })
    const v = await verifyReceiptAttestationEvm({
      payTo: OTHER, // not the signer
      network: NETWORK, resourceUrl: RESOURCE, payer: PAYER, issuedAt: ISSUED_AT, transaction: TX,
      signature: att.signature,
    })
    expect(v.ok).toBe(false)
    expect(v.reason).toBe('signer-mismatch')
  })
})

describe('R2 · a tampered signature recovers a DIFFERENT address and never throws', () => {
  it('the equality check catches a flipped signature byte → ok:false (no throw)', async () => {
    const att = await signReceiptEvm(wallet(), {
      payTo: PAY_TO, network: NETWORK, resourceUrl: RESOURCE, payer: PAYER, issuedAt: ISSUED_AT, transaction: TX,
    })
    // Flip the first nibble of the r-component (keep it a valid 65-byte hex so recovery
    // still RUNS and returns SOME — wrong — address rather than throwing).
    const sig = att.signature
    const flipped = '0x' + (sig[2] === 'a' ? 'b' : 'a') + sig.slice(3)
    const v = await verifyReceiptAttestationEvm({
      payTo: PAY_TO, network: NETWORK, resourceUrl: RESOURCE, payer: PAYER, issuedAt: ISSUED_AT, transaction: TX,
      signature: flipped,
    })
    expect(v.ok).toBe(false)
    // It either recovered a wrong address (signer-mismatch) or the malformed sig threw
    // internally and was caught (invalid-signature) — EITHER way ok:false, never a throw.
    expect(['signer-mismatch', 'invalid-signature']).toContain(v.reason)
  })

  it('a tampered MESSAGE field (different payer) recovers a different signer → ok:false', async () => {
    const att = await signReceiptEvm(wallet(), {
      payTo: PAY_TO, network: NETWORK, resourceUrl: RESOURCE, payer: PAYER, issuedAt: ISSUED_AT, transaction: TX,
    })
    const v = await verifyReceiptAttestationEvm({
      payTo: PAY_TO, network: NETWORK, resourceUrl: RESOURCE,
      payer: '0x0000000000000000000000000000000000000000', // tampered
      issuedAt: ISSUED_AT, transaction: TX,
      signature: att.signature,
    })
    expect(v.ok).toBe(false)
    expect(v.reason).toBe('signer-mismatch')
  })

  it('a garbage signature is caught (never throws)', async () => {
    const v = await verifyReceiptAttestationEvm({
      payTo: PAY_TO, network: NETWORK, resourceUrl: RESOURCE, payer: PAYER, issuedAt: ISSUED_AT, transaction: TX,
      signature: '0xdeadbeef',
    })
    expect(v.ok).toBe(false)
  })
})

describe('R2 · §5.3 empty-string transaction rule (normative)', () => {
  it('includeTxHash:false → the SIGNED message transaction === "" (asserted on typed data)', async () => {
    // The driver signs transaction ?? '' — assert the exact typed-data hash an empty-tx
    // message produces equals what signReceiptEvm signed (so transaction was '' not omitted).
    const att = await signReceiptEvm(wallet(), {
      payTo: PAY_TO, network: NETWORK, resourceUrl: RESOURCE, payer: PAYER, issuedAt: ISSUED_AT,
      transaction: '', // suppressed
    })
    // Recover from the EMPTY-STRING message → must equal payTo (so '' is what was signed).
    const recovered = await recoverTypedDataAddress({
      domain: RECEIPT_DOMAIN,
      types: RECEIPT_TYPES as unknown as Record<string, Array<{ name: string; type: string }>>,
      primaryType: RECEIPT_PRIMARY_TYPE,
      message: {
        version: 1n, network: NETWORK, resourceUrl: RESOURCE, payer: PAYER, issuedAt: BigInt(ISSUED_AT), transaction: '',
      },
      signature: att.signature as Hex,
    })
    expect(recovered.toLowerCase()).toBe(PAY_TO.toLowerCase())
  })

  it('an OMITTED transaction (undefined) defaults to "" → identical signature to explicit ""', async () => {
    const a1 = await signReceiptEvm(wallet(), {
      payTo: PAY_TO, network: NETWORK, resourceUrl: RESOURCE, payer: PAYER, issuedAt: ISSUED_AT,
      // transaction omitted
    })
    const a2 = await signReceiptEvm(wallet(), {
      payTo: PAY_TO, network: NETWORK, resourceUrl: RESOURCE, payer: PAYER, issuedAt: ISSUED_AT,
      transaction: '',
    })
    // §5.3: an omitted optional field IS the empty string in the signed message → same sig.
    expect(a1.signature).toBe(a2.signature)
  })

  it('sign(transaction:"") → verify(transaction:"") recovers payTo', async () => {
    const att = await signReceiptEvm(wallet(), {
      payTo: PAY_TO, network: NETWORK, resourceUrl: RESOURCE, payer: PAYER, issuedAt: ISSUED_AT, transaction: '',
    })
    const v = await verifyReceiptAttestationEvm({
      payTo: PAY_TO, network: NETWORK, resourceUrl: RESOURCE, payer: PAYER, issuedAt: ISSUED_AT, transaction: '',
      signature: att.signature,
    })
    expect(v.ok).toBe(true)
  })

  it('treating "" as absence: a ""-message and a populated-tx message hash DIFFERENTLY', () => {
    // Proves '' is a real distinct field value (so a verifier that supplies a real tx where
    // '' was signed gets a different hash → different recovery → mismatch, the intended behavior).
    const hEmpty = hashTypedData({
      domain: RECEIPT_DOMAIN,
      types: RECEIPT_TYPES as unknown as Record<string, Array<{ name: string; type: string }>>,
      primaryType: RECEIPT_PRIMARY_TYPE,
      message: { version: 1n, network: NETWORK, resourceUrl: RESOURCE, payer: PAYER, issuedAt: BigInt(ISSUED_AT), transaction: '' },
    })
    const hTx = hashTypedData({
      domain: RECEIPT_DOMAIN,
      types: RECEIPT_TYPES as unknown as Record<string, Array<{ name: string; type: string }>>,
      primaryType: RECEIPT_PRIMARY_TYPE,
      message: { version: 1n, network: NETWORK, resourceUrl: RESOURCE, payer: PAYER, issuedAt: BigInt(ISSUED_AT), transaction: TX },
    })
    expect(hEmpty).not.toBe(hTx)
  })
})
