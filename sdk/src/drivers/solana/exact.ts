/**
 * ── SOLANA SECTION: x402 `exact` scheme (SVM) — BUYER + SELLER ─────────────
 *
 * PipRail's own gates default to `onchain-proof` (the buyer broadcasts a normal
 * transfer and proves it with a signature). This module is the standard x402
 * `exact` interop for Solana, in BOTH directions, on the existing
 * `@solana/web3.js` + `@solana/spl-token` lazy peers (no new dep) — mirroring
 * `drivers/evm/exact.ts`.
 *
 *   • BUYER side (client) — {@link payExactSolana} compiles an SPL `TransferChecked`
 *     into a versioned transaction whose **fee payer is the MERCHANT** (the rail's
 *     `extra.feePayer`), signs ONLY its own slot (a partially-signed tx, fee-payer
 *     slot left empty), and emits the base64 transaction as the payload. The buyer
 *     spends ZERO SOL on the network fee — the merchant pays it to RECEIVE.
 *
 *   • SELLER side (gate) — {@link verifyAndSettleExactSolana} verifies the inbound
 *     partial-signed tx against the trusted `accept` (re-deriving every field), then
 *     SELF-SETTLES it: it co-signs as the fee payer and broadcasts via the caller's
 *     RPC — no third-party facilitator. This is what lets a PipRail Solana gate get
 *     PAID by any standard x402 client.
 *
 * The x402 SVM `exact` scheme (`specs/schemes/exact/scheme_exact_svm.md`) defines
 * three fee-payer MUST-rules the seller enforces before signing: the fee payer MUST
 * NOT appear in any instruction's accounts, MUST NOT be invoked as a program, and MUST
 * NOT be debited beyond the network fee — and any Address Lookup Tables MUST be resolved
 * so every touched account is visible. Because the fee payer (the merchant's relayer key)
 * appears in the transfer instruction's accounts ONLY when it equals `payTo`, the rail
 * REQUIRES `feePayer !== payTo` (PipRail already separates the gas `relayer` from `payTo`).
 *
 * Native SOL is NOT exact-payable here (the scheme is defined over SPL `TransferChecked`);
 * native stays `onchain-proof`, exactly as EVM excludes its native coin.
 */
import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  type Connection,
} from '@solana/web3.js'
import {
  createTransferCheckedInstruction,
  decodeTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token'
import bs58 from 'bs58'
import { SettlementError, UnsupportedSchemeError } from '../../errors.js'
import type { VerifyErrorCode, VerifyResult, X402ExactAcceptEntry } from '../../x402.js'

// The canonical x402 SVM `exact` transaction is FOUR instructions — a compute-unit limit, a
// compute-unit price, the SPL TransferChecked, then an SPL-Memo — matching the reference client, so
// strict facilitators (which reject any other instruction count / a too-high CU limit) accept it.
// The Memo is the scheme MUST-rule (§1.2/§3.1): `extra.memo` when present, else a random ≥16-byte
// hex nonce for transaction uniqueness across concurrent identical-parameter payments. Four
// instructions stay inside Path-1's 3-to-7 fast path, and SPL-Memo is category-exempt (§2.2.2).
const COMPUTE_UNIT_LIMIT = 20_000
const COMPUTE_UNIT_PRICE_MICROLAMPORTS = 1

/** The SPL-Memo program (category-exempt §2.2.2). Takes NO accounts; its data is the raw UTF-8
 *  memo. Hand-built here to avoid adding `@solana/spl-memo` as a dependency. */
const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr')
/** The scheme caps `extra.memo` at 256 bytes (§3.1). */
const MAX_MEMO_BYTES = 256

// Anti-drain caps the SELLER enforces on the inbound tx before co-signing as fee payer. The fee
// payer (the merchant's relayer / a keyless facilitator) is debited base + compute_unit_limit ×
// compute_unit_price; NO instruction NAMES it, so the isolation check (B4) can't see this. Without a
// cap a malicious buyer could set a huge limit/price (Solana's max limit is 1.4M units) and drain
// the sponsor for a sub-cent transfer. These ceilings are generous vs the canonical 20k-unit @
// 1-µlamport path (worst case ≈ 300k × 100k / 1e6 ≈ 0.00003 SOL) yet far below any meaningful drain.
// Mirrors the Algorand MAX_GROUP_FEE / Aptos gas caps — the same fee-payer drain class.
const MAX_COMPUTE_UNIT_LIMIT = 300_000n
const MAX_COMPUTE_UNIT_PRICE_MICROLAMPORTS = 100_000n
/** ComputeBudgetProgram instruction discriminators (first data byte). */
const CB_SET_UNIT_LIMIT = 2
const CB_SET_UNIT_PRICE = 3

/** Resolve the rail's token program (an ATA's address depends on it). Defaults to classic
 *  spl-token — the built-in USDC/USDT are classic. */
function tokenProgramFor(accept: X402ExactAcceptEntry): PublicKey {
  return accept.extra?.tokenProgram === 'token-2022' ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID
}

/**
 * Read an SPL mint's `decimals` straight off the chain. The SPL Mint account is a fixed 82-byte
 * layout — `mintAuthorityOption(4) · mintAuthority(32) · supply(8) · decimals(1) · …` — so the
 * decimals byte is at offset 44, for both the classic token program and token-2022 (whose extra
 * data is appended AFTER the base layout). Returns `undefined` on any read failure or a
 * short/absent account, so the caller can fall back rather than crash.
 */
async function readMintDecimals(
  connection: Pick<Connection, 'getAccountInfo'>,
  mint: PublicKey
): Promise<number | undefined> {
  try {
    const info = await connection.getAccountInfo(mint)
    const data = (info as { data?: Uint8Array } | null)?.data
    if (!data || data.length < 45) return undefined
    return data[44]
  } catch {
    return undefined // transient RPC failure — the caller falls back to the rail's stated value
  }
}

/** A 64-byte signature slot is "empty" (unsigned) when every byte is zero. */
function isEmptySig(sig: Uint8Array | null | undefined): boolean {
  return !sig || sig.every((b) => b === 0)
}

/** Absent `extra.memo` → 16 CSPRNG bytes, hex-encoded (32 ASCII chars) for UTF-8 compliance + tx
 *  uniqueness. Uses Web Crypto (`globalThis.crypto.getRandomValues`, headless + browser parity) — the
 *  SDK's canonical cross-platform CSPRNG, mirroring the EVM/Algorand exact nonces (NOT `node:crypto`). */
function memoRandomNonce(): Buffer {
  const g = globalThis.crypto
  if (!g?.getRandomValues) {
    throw new UnsupportedSchemeError(
      'this runtime lacks Web Crypto (globalThis.crypto.getRandomValues); SVM exact needs a CSPRNG nonce.'
    )
  }
  const raw = new Uint8Array(16)
  g.getRandomValues(raw)
  return Buffer.from([...raw].map((b) => b.toString(16).padStart(2, '0')).join(''), 'utf8')
}

/** Spec §1.2/§3.1: the Memo data is `extra.memo` when present (verbatim UTF-8, ≤256 bytes), else a
 *  random ≥16-byte hex nonce. */
function memoDataFor(accept: X402ExactAcceptEntry): Buffer {
  if (accept.extra?.memo !== undefined) {
    const bytes = Buffer.from(accept.extra.memo, 'utf8')
    if (bytes.length > MAX_MEMO_BYTES) {
      throw new UnsupportedSchemeError(
        `SVM exact: extra.memo is ${bytes.length} bytes; the scheme caps it at ${MAX_MEMO_BYTES}.`
      )
    }
    return bytes
  }
  return memoRandomNonce()
}

/** The signer-less SPL-Memo instruction the buyer appends (the scheme MUST). */
function memoInstruction(accept: X402ExactAcceptEntry): TransactionInstruction {
  return new TransactionInstruction({ programId: MEMO_PROGRAM_ID, keys: [], data: memoDataFor(accept) })
}

/* ───────────────────────────── BUYER SIDE (client) ───────────────────────────── */

/**
 * BUYER — build + partially-sign an SVM `exact` payment for a standard x402 `exact`
 * rail. Compiles the canonical v0 transaction — exactly `[setComputeUnitLimit, setComputeUnitPrice,
 * TransferChecked, Memo]` — with the **fee payer** (`accept.extra.feePayer`: the merchant's relayer in
 * self mode, or the facilitator's sponsor in facilitator mode) as the payer, paying `accept.amount`
 * of the mint to `payTo`'s ATA. The trailing SPL-Memo is the scheme MUST-rule: `extra.memo` verbatim
 * when present, else a random ≥16-byte hex nonce (transaction uniqueness). Signs ONLY the buyer's
 * slot, leaving the fee-payer slot empty for whoever sponsors. Returns the base64 transaction payload,
 * the payer address, and a dedupe `nonce` = the buyer's signature (base58) — stable across
 * re-presentations of the SAME signed tx.
 *
 * The TransferChecked `decimals` are read from the MINT on-chain, never taken from the server —
 * `extra.decimals` is a PipRail convenience the SVM scheme doesn't define and 99.3% of live rails
 * omit (it is kept only as a fallback if the mint read fails, and a mismatch is refused).
 *
 * THROWS {@link UnsupportedSchemeError} for native (not SVM-exact-payable), a missing/invalid
 * `feePayer`, `feePayer === payTo`, an unreadable mint, an `extra.memo` over the
 * 256-byte scheme cap, or when `payTo`'s token account doesn't exist yet (the exact rail can't create
 * it — use `onchain-proof`, which does).
 */
export async function payExactSolana(input: {
  connection: Pick<Connection, 'getLatestBlockhash' | 'getAccountInfo'>
  keypair: Keypair
  accept: X402ExactAcceptEntry
}): Promise<{ payload: { transaction: string }; payerFrom: string; nonce: string }> {
  const { connection, keypair, accept } = input

  if (accept.asset === 'native') {
    throw new UnsupportedSchemeError(
      'SVM exact is SPL-token only (TransferChecked); native SOL is not exact-payable. Pay via onchain-proof.'
    )
  }
  // A FOREIGN rail may omit `extra` entirely (the type now says so — the exact-EVM scheme makes
  // every key optional and the SVM scheme defines no `assetTransferMethod` at all). The two keys
  // the SVM scheme DOES require are checked right here, so a rail without them fails typed
  // instead of dereferencing undefined.
  const extra = accept.extra ?? {}
  if (!extra.feePayer) {
    throw new UnsupportedSchemeError('SVM exact rail must advertise extra.feePayer (the merchant sponsor key).')
  }
  let feePayer: PublicKey
  let mint: PublicKey
  let payTo: PublicKey
  try {
    feePayer = new PublicKey(extra.feePayer)
    mint = new PublicKey(accept.asset)
    payTo = new PublicKey(accept.payTo)
  } catch (err) {
    throw new UnsupportedSchemeError(
      `SVM exact: bad feePayer/asset/payTo (${err instanceof Error ? err.message : String(err)}).`
    )
  }

  /*
   * TransferChecked carries the mint's decimals, and they come FROM THE MINT — never from the
   * server. This used to require `extra.decimals` and throw without it, which is the same mistake
   * the buyer made with `assetTransferMethod`: `decimals` is a PipRail convenience that
   * `scheme_exact_svm.md` never defines (its only required extra is `feePayer`), and just 41 of the
   * 5,760 live Solana rails carry it. Requiring it meant 99.3% of them planned as payable and then
   * threw at signing time. Reading the mint is also strictly safer — a server that understated
   * decimals could otherwise make the buyer sign a transfer 10^n times larger than quoted, and
   * TransferChecked would happily accept it. `extra.decimals` survives only as a fallback for a
   * transient RPC failure (a PipRail gate always sets it).
   */
  const onChainDecimals = await readMintDecimals(connection, mint)
  const decimals = onChainDecimals ?? extra.decimals
  if (decimals === undefined) {
    throw new UnsupportedSchemeError(
      `SVM exact: couldn't read the decimals of mint ${accept.asset} on-chain, and the rail states ` +
        `none. Retry with a reliable rpcUrl — TransferChecked cannot be built without them.`
    )
  }
  if (onChainDecimals !== undefined && extra.decimals !== undefined && extra.decimals !== onChainDecimals) {
    throw new UnsupportedSchemeError(
      `SVM exact: the rail states ${extra.decimals} decimals for ${accept.asset} but the mint says ` +
        `${onChainDecimals} — refusing to sign (a mismatch this size misprices the transfer).`
    )
  }
  if (feePayer.equals(payTo)) {
    throw new UnsupportedSchemeError(
      'SVM exact: the fee payer must differ from payTo — payTo appears in the transfer instruction, ' +
        'which the fee payer must not (a scheme MUST-rule). Use a separate relayer key for the gate.'
    )
  }

  const program = tokenProgramFor(accept)
  const source = getAssociatedTokenAddressSync(mint, keypair.publicKey, true, program)
  const dest = getAssociatedTokenAddressSync(mint, payTo, true, program)

  // The recipient's token account MUST already exist — the canonical SVM `exact` transaction is
  // exactly [cu-limit, cu-price, TransferChecked] and never creates an account (creating one would
  // add an instruction that strict facilitators reject, and would have the buyer fund rent into the
  // gasless flow). A merchant's receive account exists once it has received any of the token (or it
  // can be pre-created); a brand-new recipient can still be paid on the `onchain-proof` rail, which
  // creates the account. A transient read failure does NOT block — only a definitive "missing".
  let destInfo: unknown = 'unknown'
  try {
    destInfo = await input.connection.getAccountInfo(dest)
  } catch {
    destInfo = 'unknown' // RPC hiccup — don't block; the facilitator/seller will catch a real miss
  }
  if (destInfo === null) {
    throw new UnsupportedSchemeError(
      `SVM exact: the recipient's token account for ${mint.toBase58()} doesn't exist yet — the exact ` +
        `rail can't create it. Pay via onchain-proof (which creates it), or have ${payTo.toBase58()} ` +
        `create its associated token account first.`
    )
  }

  // [0] compute-unit limit, [1] compute-unit price, [2] the SPL TransferChecked, [3] the SPL-Memo —
  // the canonical four-instruction form every standard SVM facilitator validates against. The Memo is
  // the scheme MUST (extra.memo, else a random hex nonce); building it FIRST surfaces an over-256-byte
  // memo before any RPC work.
  const memoIx = memoInstruction(accept)
  const instructions: TransactionInstruction[] = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNIT_LIMIT }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: COMPUTE_UNIT_PRICE_MICROLAMPORTS }),
    createTransferCheckedInstruction(
      source,
      mint,
      dest,
      keypair.publicKey,
      BigInt(accept.amount),
      decimals, // read from the MINT (see above), not from the server's `extra`
      [],
      program
    ),
    memoIx, // [3] SPL-Memo (scheme MUST); keeps the tx at 4 ix, inside Path-1's 3-to-7.
  ]

  const { blockhash } = await connection.getLatestBlockhash()
  // Compile with the MERCHANT as the fee payer (account index 0). No lookup tables — a
  // fully-static message keeps every account visible to the gate's MUST-rule checks.
  const message = new TransactionMessage({
    payerKey: feePayer,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message()
  const tx = new VersionedTransaction(message)

  // Partial-sign: sign ONLY the buyer's slot. The fee-payer slot (index 0) stays zero-filled
  // for the gate to complete.
  tx.sign([keypair])

  const buyerIndex = message.staticAccountKeys.findIndex((k) => k.equals(keypair.publicKey))
  if (buyerIndex < 1 || buyerIndex >= message.header.numRequiredSignatures) {
    // Degenerate compile (should never happen — the buyer is a required signer past the fee payer).
    throw new UnsupportedSchemeError('SVM exact: could not locate the buyer signer slot.')
  }
  const buyerSig = tx.signatures[buyerIndex]
  if (!buyerSig || isEmptySig(buyerSig)) {
    throw new UnsupportedSchemeError('SVM exact: the wallet did not produce a buyer signature.')
  }

  const transaction = Buffer.from(tx.serialize()).toString('base64')
  return {
    payload: { transaction },
    payerFrom: keypair.publicKey.toBase58(),
    nonce: bs58.encode(buyerSig),
  }
}

/* ───────────────────────────── SELLER SIDE (gate) ────────────────────────────── */

/** Shorten a long error message for a `detail` field. */
function shorten(msg: string): string {
  const oneLine = msg.replace(/\s+/g, ' ').trim()
  return oneLine.length > 200 ? `${oneLine.slice(0, 200)}…` : oneLine
}

function fail(error: VerifyErrorCode, detail: string): VerifyResult {
  return { ok: false, error, detail }
}

/** The connection surface the seller needs — kept narrow so tests inject a mock. */
type SellerConnection = Pick<
  Connection,
  'getAddressLookupTable' | 'simulateTransaction' | 'sendRawTransaction' | 'getSignatureStatuses'
>

/**
 * SELLER — verify an inbound SVM `exact` payment against the trusted `accept`, then
 * SELF-SETTLE it: co-sign as the fee payer and broadcast via the caller's RPC. The
 * trusted `accept` (the gate's own rail) is the sole source of truth for payTo / amount /
 * asset / mint — the client's transaction is only matched and bound against it.
 *
 * RETURNS a {@link VerifyResult}: `{ ok:false, error }` for a CLIENT-fixable fault (the gate
 * replies 402); `{ ok:true, receipt }` once the settle tx confirms. THROWS
 * {@link SettlementError} for a SERVER-side settle failure (a VALID tx that fails to
 * broadcast/confirm — RPC down, fee payer out of SOL) or a gate misconfiguration → the gate
 * replies 5xx and the buyer's signed tx stays valid + re-presentable.
 */
export async function verifyAndSettleExactSolana(input: {
  connection: SellerConnection
  feePayerKeypair: Keypair
  payload: { transaction: string }
  accept: X402ExactAcceptEntry
}): Promise<VerifyResult> {
  const { connection, feePayerKeypair, payload, accept } = input

  // --- B0. Config guards (the gate's own faults → throw, never a 402) ---
  let payTo: PublicKey
  let mint: PublicKey
  let railFeePayer: PublicKey
  try {
    payTo = new PublicKey(accept.payTo)
    mint = new PublicKey(accept.asset)
    if (!accept.extra?.feePayer) throw new Error('rail is missing extra.feePayer')
    railFeePayer = new PublicKey(accept.extra.feePayer)
  } catch (err) {
    throw new SettlementError(`SVM exact: rail has a bad payTo/asset/feePayer (${err instanceof Error ? err.message : String(err)}).`)
  }
  if (!railFeePayer.equals(feePayerKeypair.publicKey)) {
    throw new SettlementError(
      'SVM exact: the gate relayer key does not match the rail extra.feePayer — misconfigured rail.'
    )
  }
  if (feePayerKeypair.publicKey.equals(payTo)) {
    throw new SettlementError('SVM exact: the fee payer must differ from payTo — misconfigured rail.')
  }
  const program = tokenProgramFor(accept)

  // --- B1. Deserialize (reject anything but a v0 message) ---
  let tx: VersionedTransaction
  try {
    tx = VersionedTransaction.deserialize(Buffer.from(payload.transaction, 'base64'))
  } catch (err) {
    return fail('signature_invalid', `Unparseable SVM transaction: ${shorten(err instanceof Error ? err.message : String(err))}.`)
  }
  const message = tx.message
  if (message.version !== 0) {
    return fail('signature_invalid', 'SVM exact requires a versioned (v0) transaction.')
  }

  // --- B2. Resolve Address Lookup Tables so every touched account is visible (MUST-rule) ---
  const altAccounts: AddressLookupTableAccount[] = []
  for (const lookup of message.addressTableLookups) {
    let value: AddressLookupTableAccount | null
    try {
      ;({ value } = await connection.getAddressLookupTable(lookup.accountKey))
    } catch {
      return fail('tx_not_found', `Could not read lookup table ${lookup.accountKey.toBase58()} (transient RPC) — retry.`)
    }
    if (!value) {
      return fail('signature_invalid', `Lookup table ${lookup.accountKey.toBase58()} is not resolvable — account visibility cannot be guaranteed.`)
    }
    altAccounts.push(value)
  }
  const keys = message.getAccountKeys({ addressLookupTableAccounts: altAccounts })

  // --- B3. Fee-payer identity (index 0) + empty slot ---
  const feePayerKey = keys.get(0)
  if (!feePayerKey || !feePayerKey.equals(feePayerKeypair.publicKey)) {
    return fail('signature_invalid', 'Transaction fee payer is not the merchant sponsor key.')
  }
  if (!isEmptySig(tx.signatures[0])) {
    return fail('signature_invalid', 'The fee-payer signature slot must be empty — the buyer must not sign it.')
  }

  // --- B4. Isolation (MUST-rule #1) — fee payer in NO instruction's accounts, never a program.
  //     Compared by PUBKEY against the ALT-RESOLVED keys (not the literal index 0), so an
  //     attacker can't hide the fee payer behind a lookup-table reference. This also subsumes
  //     "no fund drain" (rule #3): an instruction can't debit the fee payer without naming it. ---
  for (const ix of message.compiledInstructions) {
    const ixProgram = keys.get(ix.programIdIndex)
    if (ixProgram && ixProgram.equals(feePayerKey)) {
      return fail('signature_invalid', 'The fee payer is invoked as a program.')
    }
    for (const i of ix.accountKeyIndexes) {
      if (keys.get(i)?.equals(feePayerKey)) {
        return fail('signature_invalid', 'The fee payer appears in an instruction account list (would risk a fund drain).')
      }
    }
  }

  // --- B4.5. Anti-drain (MUST-rule #3 — "not debited beyond the network fee"): bound the COMPUTE
  //     BUDGET. The fee payer pays base + compute_unit_limit × compute_unit_price; the canonical
  //     buyer sets a tiny fixed budget, but a malicious one could set a huge limit/price and drain
  //     the sponsor — no instruction names the fee payer, so B4 misses it. Cap both. ---
  //     ALLOWLIST, not a match-some: reject EVERY ComputeBudget discriminator other than
  //     set-unit-limit (2) / set-unit-price (3). The canonical buyer emits only those two, but the
  //     program also decodes the DEPRECATED `RequestUnits` (disc 0), whose `additional_fee` is a
  //     flat lamport prioritization fee up to u32 (~4.29 SOL) the fee payer pays — uncapped by the
  //     limit/price caps and invisible to B4 (ComputeBudget ix name no accounts) and to the
  //     simulation (a big fee is "valid"). An if/else-if that only matched 2/3 would wave disc 0
  //     straight through. So: cap 2/3, and reject anything else.
  for (const ix of message.compiledInstructions) {
    const ixProgram = keys.get(ix.programIdIndex)
    if (!ixProgram || !ixProgram.equals(ComputeBudgetProgram.programId)) continue
    const data = Buffer.from(ix.data)
    if (data.length >= 5 && data[0] === CB_SET_UNIT_LIMIT) {
      const limit = BigInt(data.readUInt32LE(1))
      if (limit > MAX_COMPUTE_UNIT_LIMIT) {
        return fail('signature_invalid', `Compute-unit limit ${limit} exceeds the ${MAX_COMPUTE_UNIT_LIMIT} cap (fee-payer drain guard).`)
      }
    } else if (data.length >= 9 && data[0] === CB_SET_UNIT_PRICE) {
      const price = data.readBigUInt64LE(1)
      if (price > MAX_COMPUTE_UNIT_PRICE_MICROLAMPORTS) {
        return fail('signature_invalid', `Compute-unit price ${price} µlamports exceeds the ${MAX_COMPUTE_UNIT_PRICE_MICROLAMPORTS} cap (fee-payer drain guard).`)
      }
    } else {
      return fail('signature_invalid', `Unexpected ComputeBudget instruction (discriminator ${data[0]}) — only set-unit-limit/price are allowed (fee-payer drain guard).`)
    }
  }

  // Is `pubkey` an authentic signer of this tx — a required-signer slot with a non-empty
  // signature? (Signers are always STATIC keys; lookup tables can't supply signers.)
  const isSignedSigner = (pubkey: PublicKey): boolean => {
    const idx = message.staticAccountKeys.findIndex((k) => k.equals(pubkey))
    return idx >= 1 && idx < message.header.numRequiredSignatures && !isEmptySig(tx.signatures[idx])
  }

  // --- B5/B6. Locate + decode each TransferChecked for OUR token program, bind every field to
  //     the trusted accept, and COUNT it only when its authority is an authentic signer — so the
  //     gate's own structural check is self-sufficient (it never credits an unsigned transfer,
  //     independent of the sigVerify simulation below). ---
  const expectedDest = getAssociatedTokenAddressSync(mint, payTo, true, program)
  const requiredAmount = BigInt(accept.amount)
  let paidToPayTo = 0n
  let buyerOwner: PublicKey | null = null
  let sawTransferToPayTo = false

  for (const ix of message.compiledInstructions) {
    const programId = keys.get(ix.programIdIndex)
    if (!programId || !programId.equals(program)) continue
    let decoded
    try {
      decoded = decodeTransferCheckedInstruction(
        new TransactionInstruction({
          programId,
          keys: ix.accountKeyIndexes.map((i) => ({
            pubkey: keys.get(i)!,
            isSigner: message.isAccountSigner(i),
            isWritable: message.isAccountWritable(i),
          })),
          data: Buffer.from(ix.data),
        }),
        program
      )
    } catch {
      continue // not a TransferChecked (some other token-program ix) — skip
    }
    // Bind to the trusted accept: right mint, destination is EXACTLY payTo's ATA (recomputed,
    // so it can't be redirected), correct decimals.
    if (!decoded.keys.mint.pubkey.equals(mint)) continue
    if (!decoded.keys.destination.pubkey.equals(expectedDest)) {
      return fail('wrong_recipient', `A transfer pays ${decoded.keys.destination.pubkey.toBase58()}, not payTo's ATA ${expectedDest.toBase58()}.`)
    }
    // Belt-and-braces: a PipRail gate always states `extra.decimals`, so cross-check the
    // instruction against it. A rail that states none (the SVM scheme never defines the key) is
    // NOT rejected here — the chain itself is the guard, since TransferChecked reverts unless its
    // decimals match the mint, and the amount is re-derived from the trusted accept regardless.
    if (accept.extra?.decimals !== undefined && decoded.data.decimals !== accept.extra.decimals) {
      return fail('transfer_not_found', `Transfer decimals ${decoded.data.decimals} ≠ rail decimals ${accept.extra.decimals}.`)
    }
    sawTransferToPayTo = true
    // Count ONLY an authentically-signed transfer — an unsigned/forged authority contributes 0,
    // so a "tiny signed + large unsigned" tx can never reach the required amount here.
    if (!isSignedSigner(decoded.keys.owner.pubkey)) continue
    paidToPayTo += BigInt(decoded.data.amount)
    buyerOwner = decoded.keys.owner.pubkey // the transfer authority = the (signed) buyer
  }

  if (!buyerOwner) {
    return fail(
      sawTransferToPayTo ? 'signature_invalid' : 'transfer_not_found',
      sawTransferToPayTo
        ? "A TransferChecked to payTo's ATA is not authorized by a transaction signer."
        : `No TransferChecked of mint ${mint.toBase58()} (program ${program.toBase58()}) found.`
    )
  }
  if (paidToPayTo < requiredAmount) {
    return fail('amount_too_low', `Signed transfers pay ${paidToPayTo} to payTo, required ${requiredAmount}.`)
  }

  // --- B7. Re-affirm the reported buyer is a present signer (already true via isSignedSigner;
  //     kept as the explicit invariant). Authenticity is then proven by the sigVerify simulation. ---
  const buyerIndex = message.staticAccountKeys.findIndex((k) => k.equals(buyerOwner!))
  if (buyerIndex < 1 || buyerIndex >= message.header.numRequiredSignatures) {
    return fail('signature_invalid', 'The transfer authority is not a transaction signer.')
  }
  if (isEmptySig(tx.signatures[buyerIndex])) {
    return fail('signature_invalid', 'The buyer signature slot is empty.')
  }

  // --- B8. Co-sign as the fee payer. VersionedTransaction.sign() fills ONLY the slots for
  //     the passed signers and PRESERVES every other signature (verified) — so the buyer's
  //     signature survives intact and only the fee-payer slot (index 0) is completed. ---
  tx.sign([feePayerKeypair])

  // --- B9. Simulate with sigVerify BEFORE broadcast — verifies BOTH signatures (a forged
  //     buyer sig → signature_invalid), catches an expired blockhash (payment_expired) and any
  //     execution revert (tx_reverted), and costs the fee payer nothing. ---
  try {
    const sim = await connection.simulateTransaction(tx, { sigVerify: true, replaceRecentBlockhash: false, commitment: 'confirmed' })
    if (sim.value.err) {
      const errStr = typeof sim.value.err === 'string' ? sim.value.err : JSON.stringify(sim.value.err)
      if (/blockhash|block height|expired/i.test(errStr)) return fail('payment_expired', `Transaction blockhash is no longer valid: ${shorten(errStr)}.`)
      if (/signature/i.test(errStr)) return fail('signature_invalid', `Signature verification failed: ${shorten(errStr)}.`)
      return fail('tx_reverted', `Transaction would fail on-chain: ${shorten(errStr)}.`)
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/signature verification|invalid signature/i.test(msg)) return fail('signature_invalid', `Signature verification failed: ${shorten(msg)}.`)
    if (/blockhash|block height|expired/i.test(msg)) return fail('payment_expired', `Transaction blockhash is no longer valid: ${shorten(msg)}.`)
    return fail('tx_not_found', `Could not simulate the transaction (transient RPC) — retry: ${shorten(msg)}.`)
  }

  // --- B10. BROADCAST (settle). The returned signature (the fee payer's) IS the on-chain txid.
  //     A failure of a VALID tx is SERVER-side → SettlementError (gate 5xx), EXCEPT an expired
  //     blockhash race, which is the payer's to retry. ---
  let txid: string
  try {
    txid = await connection.sendRawTransaction(tx.serialize(), { maxRetries: 5 })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/blockhash|block height|expired/i.test(msg)) return fail('payment_expired', `Settle broadcast rejected — blockhash expired: ${shorten(msg)}.`)
    throw new SettlementError(
      `SVM exact settle: the merchant fee payer failed to broadcast (${shorten(msg)}). The buyer's signed ` +
        `transaction is still valid — fund/fix the fee payer and the buyer can re-present it.`,
      { cause: err }
    )
  }

  // --- B11. Confirm (commitment, not a count — SVM has no minConfirmations). Poll the status. ---
  const confirmed = await pollConfirmed(connection, txid)
  if (confirmed === 'reverted') {
    return fail('tx_reverted', `Settle tx ${txid} reverted on-chain (a post-simulate race).`)
  }
  if (confirmed === 'timeout') {
    throw new SettlementError(
      `SVM exact settle: broadcast ${txid} but it did not confirm in time. It likely landed — re-verify by ` +
        `signature before re-presenting; do NOT re-pay.`
    )
  }

  return {
    ok: true,
    receipt: {
      scheme: 'exact',
      success: true,
      network: accept.network,
      transaction: txid,
      asset: accept.asset,
      amount: accept.amount,
      payer: buyerOwner.toBase58(),
      payTo: accept.payTo,
      verifiedAt: new Date().toISOString(),
    },
  }
}

/** Poll a signature to `confirmed`/`finalized`. Returns 'ok' on success, 'reverted' on an
 *  on-chain error, 'timeout' if it never lands in the window. Never throws (RPC reads guarded). */
async function pollConfirmed(
  connection: Pick<Connection, 'getSignatureStatuses'>,
  signature: string
): Promise<'ok' | 'reverted' | 'timeout'> {
  const deadline = Date.now() + 30_000
  for (;;) {
    let info
    try {
      const { value } = await connection.getSignatureStatuses([signature], { searchTransactionHistory: true })
      info = value[0]
    } catch {
      info = null
    }
    if (info) {
      if (info.err) return 'reverted'
      if (info.confirmationStatus === 'confirmed' || info.confirmationStatus === 'finalized') return 'ok'
    }
    if (Date.now() >= deadline) return 'timeout'
    await new Promise((r) => setTimeout(r, 1_000))
  }
}
