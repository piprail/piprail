/**
 * ── EVM SECTION · Tier-2 service-delivery attestation ───────────────────────
 * The OPTIONAL EVM-only `signReceipt` SPI (Phase R2). The one thing the chain
 * can't attest — that the resource was actually SERVED — the merchant signs with
 * its existing `payTo` wallet over the OFFICIAL x402 `offer-receipt` EIP-712
 * `RECEIPT_TYPES`, and a verifier checks `recover(sig) === payTo`.
 *
 * VIEM LIVES ONLY HERE among the receipt code — this is a lazy chunk. The
 * protocol layer (`server.ts`/`client.ts`/`x402.ts`) reaches it by name
 * (`net.signReceipt?`) or by a lazy dynamic import, never statically, so the
 * pure-EVM bundle's lazy-chunk grep stays green and the protocol layer viem-free.
 *
 * The domain + types are FROZEN constants byte-matched against the upstream
 * `@x402/extensions` `signing.ts` (`createReceiptDomain` / `RECEIPT_TYPES`):
 *   domain      = { name: 'x402 receipt', version: '1', chainId: 1 }  (chainId 1
 *                 for ALL networks — even non-EVM payment chains — so signing is
 *                 uniform; verified spec §5.3 / signing.ts:239)
 *   primaryType = 'Receipt'
 *   field order = version,network,resourceUrl,payer,issuedAt,transaction
 *                 (LOAD-BEARING — EIP-712 hashes field order into the signature;
 *                 a wrong order silently breaks recovery; verified signing.ts:262)
 */
import {
  recoverTypedDataAddress,
  getAddress,
  type Hex,
  type TypedDataDomain,
  type WalletClient,
  type Account,
} from 'viem'
import type { SignedReceipt } from '../../x402.js'
import type { WalletHandle, ReceiptInput } from '../types.js'
import type { WalletAdapter } from './wallet.js'

/**
 * The official offer-receipt EIP-712 domain — HARDCODED for every network
 * (`chainId: 1` even on non-mainnet / non-EVM payment chains) so receipt signing
 * is uniform regardless of the payment rail. Byte-identical to `@x402/extensions`
 * `createReceiptDomain()` (signing.ts:239). Frozen so it can't be mutated.
 */
export const RECEIPT_DOMAIN: TypedDataDomain = Object.freeze({
  name: 'x402 receipt',
  version: '1',
  chainId: 1,
})

/**
 * The official offer-receipt EIP-712 types. The field order is LOAD-BEARING
 * (EIP-712 hashes it into the signature). Byte-identical to `@x402/extensions`
 * `RECEIPT_TYPES` (signing.ts:262) + spec §5.3 normative schema. Frozen.
 */
export const RECEIPT_TYPES = Object.freeze({
  Receipt: [
    { name: 'version', type: 'uint256' },
    { name: 'network', type: 'string' },
    { name: 'resourceUrl', type: 'string' },
    { name: 'payer', type: 'string' },
    { name: 'issuedAt', type: 'uint256' },
    { name: 'transaction', type: 'string' },
  ],
} as const)

/** The official primaryType — MUST NOT be transmitted on the wire (spec §3.2.1). */
export const RECEIPT_PRIMARY_TYPE = 'Receipt' as const

/** Shape the §5.2 receipt payload (all fields present; `transaction` → `''` per §5.3). */
function receiptMessage(input: ReceiptInput): {
  version: bigint
  network: string
  resourceUrl: string
  payer: string
  issuedAt: bigint
  transaction: string
} {
  return {
    version: 1n,
    network: input.network,
    resourceUrl: input.resourceUrl,
    payer: input.payer,
    issuedAt: BigInt(input.issuedAt),
    // §5.3: unused optional fields are the empty string in the SIGNED message, never omitted.
    transaction: input.transaction ?? '',
  }
}

/**
 * Sign the official EIP-712 `RECEIPT_TYPES` with the bound EVM wallet (the
 * merchant's `payTo` key). Signs via the WALLET CLIENT (not `account.signTypedData`,
 * which is `undefined` on a bring-your-own JsonRpcAccount) — exactly like the exact
 * rail's `payExactEvm`. Returns the {@link SignedReceipt} the offer-receipt envelope
 * carries: the signature plus the recovered-signer expectation (`signer === payTo`).
 *
 * The returned `signer` is the wallet's own address (the EVM account). A verifier
 * ({@link verifyReceiptAttestationEvm}) re-recovers from the signature and the
 * frozen domain/types and checks it equals `payTo` — this function does NOT trust
 * the caller's `payTo` as the signer; it records the account that actually signed.
 */
export async function signReceiptEvm(
  wallet: WalletHandle,
  input: ReceiptInput
): Promise<SignedReceipt> {
  const adapter = wallet._native as WalletAdapter
  const account = adapter.account as Account
  const walletClient = adapter.walletClient as WalletClient
  const signature = await walletClient.signTypedData({
    account,
    domain: RECEIPT_DOMAIN,
    types: RECEIPT_TYPES as unknown as Record<string, Array<{ name: string; type: string }>>,
    primaryType: RECEIPT_PRIMARY_TYPE,
    message: receiptMessage(input),
  })
  return {
    format: 'eip712',
    signature,
    // The address that actually produced the signature (the bound wallet). A
    // verifier re-recovers + checks it equals the trusted `payTo`.
    signer: account.address,
    payload: {
      version: 1,
      network: input.network,
      resourceUrl: input.resourceUrl,
      payer: input.payer,
      issuedAt: input.issuedAt,
      transaction: input.transaction ?? '',
    },
  }
}

/**
 * Verify an EVM Tier-2 attestation: re-recover the signer from the signature over
 * the frozen domain/types/message, then check `recover === payTo`. This is the
 * classic EIP-712 footgun made safe — `recoverTypedDataAddress` NEVER throws on a
 * bad signature, it returns a WRONG address; real verification is THIS explicit
 * equality check (spec §4.5.1 / §5.5). A tampered signature recovers a different
 * address → `{ ok:false }`, never a throw.
 *
 * Re-derives the signed message from the receipt's OWN fields exactly as it was
 * signed (§5.5: "the `receipt.payload` object MUST be used exactly as transmitted"),
 * honoring the §5.3 empty-string rule (`transaction` absent ⇒ `''`). Never throws:
 * a malformed attestation, bad signature, or missing field → `{ ok:false, reason }`.
 */
export async function verifyReceiptAttestationEvm(input: {
  payTo: string
  network: string
  resourceUrl: string
  payer: string
  issuedAt: number
  transaction?: string
  signature: string
}): Promise<{ ok: boolean; signer?: string; reason?: string }> {
  try {
    const recovered = await recoverTypedDataAddress({
      domain: RECEIPT_DOMAIN,
      types: RECEIPT_TYPES as unknown as Record<string, Array<{ name: string; type: string }>>,
      primaryType: RECEIPT_PRIMARY_TYPE,
      message: receiptMessage(input),
      signature: input.signature as Hex,
    })
    // The LOAD-BEARING equality check — recoverTypedDataAddress doesn't validate the
    // signature, it just recovers SOME address; only `recovered === payTo` is real
    // verification (§5.5 step 4–5). Checksum-insensitive via getAddress.
    let expected: string
    let actual: string
    try {
      expected = getAddress(input.payTo)
      actual = getAddress(recovered)
    } catch {
      return { ok: false, signer: recovered, reason: 'bad-address' }
    }
    if (actual !== expected) {
      return { ok: false, signer: recovered, reason: 'signer-mismatch' }
    }
    return { ok: true, signer: recovered }
  } catch {
    // A malformed signature / message — never throw (read-only verdict, ERRORS.md).
    return { ok: false, reason: 'invalid-signature' }
  }
}
