/**
 * ── TRON SECTION: pay ──
 * Build, sign, and broadcast a TRC-20 transfer, returning the txid.
 *
 * Binding is **digest-bound by default** (Template B, like EVM/Solana): the
 * proof ref IS the txid; binding comes from a single-use proof + recipient +
 * amount + asset + recency (the gate's used-proof set enforces single-use).
 * Memo-binding (Template A) is supported as an OPT-IN (`bind: 'memo'`) — it
 * attaches the nonce as a tx-level memo via `addUpdateData`, which must run on
 * the UNSIGNED tx because it recomputes the txID. Digest is the default because
 * the memo costs ~1 TRX, is untrusted plaintext, and some explorer APIs strip it.
 *
 * Tron amounts are integer base units (USDT is 6 dp), so `accept.amount` goes
 * verbatim — the EVM-style integer model, NOT the Stellar/XRPL string model.
 *
 * The tronweb client is injected behind a narrow interface so this is
 * unit-testable with a mock; address derivation + node config live in index.ts.
 */
import { InsufficientFundsError, toInsufficientFundsError } from '../../errors.js'
import type { X402AcceptEntry } from '../../x402.js'

/** An unsigned tronweb transaction (only `txID` is read here). */
export interface TronUnsignedTx {
  txID: string
  [k: string]: unknown
}

/** The slice of tronweb the pay path needs — adapted from a real TronWeb in index.ts. */
export interface TronPayClient {
  transactionBuilder: {
    triggerSmartContract(
      contractAddress: string,
      functionSelector: string,
      options: { feeLimit: number; callValue?: number },
      parameters: { type: string; value: unknown }[],
      issuerAddress: string
    ): Promise<{ result: { result: boolean; message?: string }; transaction: TronUnsignedTx }>
    addUpdateData(tx: TronUnsignedTx, data: string, encoding?: string): Promise<TronUnsignedTx>
  }
  trx: {
    sign(tx: TronUnsignedTx, privateKey: string): Promise<{ txID: string }>
    sendRawTransaction(signed: { txID: string }): Promise<{
      result?: boolean
      txid?: string
      transaction?: { txID: string }
      code?: string
      message?: string
    }>
  }
}

export interface PayTronParams {
  client: TronPayClient
  /** Payer address, Base58 (derived from the private key in index.ts). */
  from: string
  /** Bare hex private key (no 0x). */
  privateKey: string
  /** The TRC-20 contract to transfer, Base58 (= accept.asset). */
  tokenAddress: string
  accept: X402AcceptEntry
  /** 'digest' (default) or 'memo' (opt-in hard challenge binding). */
  bind?: 'digest' | 'memo'
}

const TRANSFER_FN = 'transfer(address,uint256)'
/** Generous TRC-20 transfer fee cap (in sun); leftover isn't spent. */
const FEE_LIMIT = 100_000_000

export async function payTron(params: PayTronParams): Promise<string> {
  const { client, from, privateKey, tokenAddress, accept, bind } = params
  try {
    const built = await client.transactionBuilder.triggerSmartContract(
      tokenAddress,
      TRANSFER_FN,
      { feeLimit: FEE_LIMIT },
      [
        { type: 'address', value: accept.payTo },
        { type: 'uint256', value: accept.amount },
      ],
      from
    )
    if (!built.result?.result) {
      throw new Error(
        `Tron transfer build failed${built.result?.message ? `: ${decodeMaybeHex(built.result.message)}` : ''}.`
      )
    }

    let unsigned = built.transaction
    if (bind === 'memo') {
      // Opt-in hard binding: attach the nonce as a tx-level memo. MUST be applied
      // to the UNSIGNED tx — it recomputes the txID.
      unsigned = await client.transactionBuilder.addUpdateData(unsigned, accept.extra.nonce, 'utf8')
    }

    const signed = await client.trx.sign(unsigned, privateKey)
    const broadcast = await client.trx.sendRawTransaction(signed)

    if (broadcast.result === true || broadcast.txid || broadcast.transaction?.txID) {
      return broadcast.txid ?? broadcast.transaction?.txID ?? signed.txID
    }

    // Broadcast rejected — map affordability to the SAME typed error as every chain.
    if (isTronAffordability(broadcast.code, broadcast.message)) {
      throw new InsufficientFundsError(
        `Tron payment rejected (${broadcast.code ?? 'broadcast'}): not enough TRX for energy/bandwidth, or insufficient token balance.`
      )
    }
    throw new Error(
      `Tron broadcast failed: ${broadcast.code ?? ''} ${decodeMaybeHex(broadcast.message)}`.trim()
    )
  } catch (err) {
    if (err instanceof InsufficientFundsError) throw err
    // Message-level backstop so affordability surfaces uniformly across chains.
    throw toInsufficientFundsError(err) ?? err
  }
}

/** Tron surfaces some error messages hex-encoded; decode when it looks like hex. */
export function decodeMaybeHex(message: string | undefined): string {
  if (!message) return ''
  if (/^[0-9a-fA-F]+$/.test(message) && message.length % 2 === 0) {
    try {
      const decoded = Buffer.from(message, 'hex').toString('utf8')
      // Only use the decode if it's printable text (else keep the raw message).
      if (/^[\x20-\x7e\s]+$/.test(decoded)) return decoded
    } catch {
      /* fall through */
    }
  }
  return message
}

/** Tron broadcast codes/messages that mean "the wallet can't afford it". */
function isTronAffordability(code: string | undefined, message: string | undefined): boolean {
  const decoded = decodeMaybeHex(message)
  if (code && /BANDWIDTH_ERROR|CONTRACT_VALIDATE_ERROR/.test(code)) {
    // These can also be other validation issues; gate on the message too.
    return /balance is not sufficient|insufficient|not enough|exceeds/i.test(decoded)
  }
  return /balance is not sufficient|insufficient (funds|balance|energy)|not enough/i.test(decoded)
}
