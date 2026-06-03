/**
 * ── STELLAR SECTION: pay ──
 * Build, sign, and submit a Stellar payment, returning the tx hash.
 *   - native XLM → Operation.payment with Asset.native()
 *   - issued     → Operation.payment with new Asset(code, issuer)
 *
 * The challenge nonce is bound via a MEMO_HASH = sha256(nonce) (32 bytes): the
 * default nonce is a UUID (36 chars), too long for MEMO_TEXT (28), and a hash
 * always fits, never leaks the nonce on-chain, and verify() re-derives it.
 *
 * Stellar amounts are human-decimal STRINGS (≤7dp), so we send
 * `accept.extra.amountFormatted` directly (already validated to ≤7dp at
 * challenge time) instead of re-scaling base units through the EVM path.
 *
 * `server` is injected (only loadAccount + submitTransaction are used) so this
 * is unit-testable with a mock.
 */
import {
  Asset,
  BASE_FEE,
  type Keypair,
  Memo,
  Operation,
  TransactionBuilder,
  hash,
  type Horizon,
} from '@stellar/stellar-sdk'
import { STELLAR_PASSPHRASE, parseStellarAssetId } from './chains.js'
import {
  InsufficientFundsError,
  RecipientNotReadyError,
  toInsufficientFundsError,
} from '../../errors.js'
import type { X402AcceptEntry } from '../../x402.js'

export interface PayStellarParams {
  server: Pick<Horizon.Server, 'loadAccount' | 'submitTransaction'>
  keypair: Keypair
  accept: X402AcceptEntry
}

/** sha256(nonce) — the 32-byte MEMO_HASH that binds a payment to its challenge. */
export function memoHashForNonce(nonce: string): Buffer {
  return Buffer.from(hash(Buffer.from(nonce, 'utf8')))
}

export async function payStellar(params: PayStellarParams): Promise<string> {
  const { server, keypair, accept } = params
  try {
    const asset = assetForAccept(accept)
    // `loadAccount` 404s for an unfunded source account — wrap it in the same
    // try so that (most common) affordability failure maps to the SAME typed
    // error as every other chain, not a raw Horizon error.
    const source = await server.loadAccount(keypair.publicKey())
    const tx = new TransactionBuilder(source, {
      fee: BASE_FEE,
      networkPassphrase: STELLAR_PASSPHRASE,
    })
      .addOperation(
        Operation.payment({
          destination: accept.payTo,
          asset,
          amount: accept.extra.amountFormatted,
        })
      )
      .addMemo(Memo.hash(memoHashForNonce(accept.extra.nonce)))
      .setTimeout(120)
      .build()
    tx.sign(keypair)
    const res = await server.submitTransaction(tx)
    return res.hash
  } catch (err) {
    throw mapSubmitError(err)
  }
}

/** Turn the wire asset id ('native' | 'CODE:ISSUER') into a Stellar Asset. */
export function assetForAccept(accept: X402AcceptEntry): Asset {
  if (accept.asset === 'native') return Asset.native()
  const parts = parseStellarAssetId(accept.asset)
  if (!parts) throw new Error(`Stellar: malformed asset id "${accept.asset}".`)
  return new Asset(parts.code, parts.issuer)
}

/** Map common Horizon failures to the SDK's typed errors (see ERRORS.md). */
function mapSubmitError(err: unknown): unknown {
  const codes = extractResultCodes(err)
  const seen = codes.join(', ')
  const has = (re: RegExp) => codes.some((c) => re.test(c))

  // Recipient-side setup → RecipientNotReadyError (fix the DESTINATION, not the payer).
  // `op_no_destination` = the payTo account doesn't exist; `op_no_trust` (PAYMENT_NO_TRUST) =
  // the destination has no trustline for the asset; `op_line_full`/`op_not_authorized` likewise.
  // `op_src_no_trust` is the SENDER's missing trustline → that's an affordability/setup case below.
  if (has(/op_no_destination/i)) {
    return new RecipientNotReadyError(
      `Stellar destination account doesn't exist yet — create it with ≥1 XLM (the base reserve) before it can receive. (Stellar: ${seen})`,
      { cause: err }
    )
  }
  if (has(/op_(no_trust|line_full|not_authorized)/i) && !has(/src_no_trust/i)) {
    return new RecipientNotReadyError(
      `Stellar destination can't hold this asset — it needs a trustline for it (and to be authorized) before it can receive. (Stellar: ${seen})`,
      { cause: err }
    )
  }
  // Sender affordability / setup → InsufficientFundsError.
  if (has(/underfunded|insufficient|low_reserve|src_no_trust/i)) {
    return new InsufficientFundsError(
      `Stellar payment failed: the sender can't cover it — balance, base reserve, or no trustline to send this asset. (Stellar: ${seen})`,
      { cause: err }
    )
  }
  // An unfunded source account doesn't exist on-chain — `loadAccount` 404s
  // before any submit; that's the SENDER not being funded yet.
  if (isAccountNotFound(err)) {
    return new InsufficientFundsError(
      'Stellar source account not found on-chain — fund the sender (≥ base reserve) before it can pay.',
      { cause: err }
    )
  }
  // Message-level backstop so affordability surfaces uniformly across chains.
  return toInsufficientFundsError(err) ?? err
}

/** Horizon returns 404 / a NotFoundError for an account that doesn't exist yet. */
function isAccountNotFound(err: unknown): boolean {
  const e = err as { response?: { status?: number }; name?: string; message?: string }
  return (
    e?.response?.status === 404 ||
    e?.name === 'NotFoundError' ||
    /not found|resource missing/i.test(e?.message ?? '')
  )
}

function extractResultCodes(err: unknown): string[] {
  // Horizon errors carry result codes under response.data.extras.result_codes.
  const extras = (
    err as {
      response?: {
        data?: { extras?: { result_codes?: { transaction?: string; operations?: string[] } } }
      }
    }
  )?.response?.data?.extras?.result_codes
  if (!extras) return []
  return [extras.transaction ?? '', ...(extras.operations ?? [])].filter(Boolean)
}
