/**
 * ── ALGORAND SECTION ──────────────────────────────────────────────────────────
 * The Algorand PaymentDriver. Same PaymentDriver contract as the other families;
 * ASAs (Algorand Standard Assets) + native ALGO underneath. The registry
 * auto-mounts this file (via the lazy loader in ../index.ts) the first time an
 * Algorand chain is used, so `algosdk` loads on demand — other installs never
 * pull it in.
 *
 * Native ALGO + native Circle USDC are built in (USDC-only: Tether deprecated
 * USDT on Algorand). Both are transferred with the challenge nonce in the
 * transaction's note field and verified by reading the merchant account's recent
 * inbound transfers.
 *
 * Template A (memo-bound, like Stellar/XRPL/NEAR): verify() re-derives the watched
 * account from the trusted `accept.payTo` (never the client ref) and matches the
 * note to the nonce — so a forged ref can't redirect verification and a stranger's
 * payment can't satisfy our challenge. Algorand is single-step final (~3s, no
 * reorgs), so confirm() just surfaces the confirming round.
 *
 * NOTE on endpoints: Algorand splits algod (submit/params, the PAY side) from the
 * indexer (history, the VERIFY side). `rpcUrl` overrides the algod endpoint; the
 * indexer uses the preset's public AlgoNode default (reliable + keyless). Pass a
 * combined provider's algod URL as `rpcUrl` in production; the public indexer is
 * production-grade for the inbound-transfer read verify needs.
 */
import algosdk from 'algosdk'
import {
  ALGORAND_MAINNET,
  ALGO_DECIMALS,
  ALGO_SYMBOL,
  algorandAssetId,
  parseAlgorandAssetId,
  type AlgorandPreset,
} from './chains.js'
import { payAlgorand, type AlgorandPayClient } from './pay.js'
import {
  payExactAlgorand,
  verifyAndSettleExactAlgorand,
  type AlgorandSettleClient,
} from './exact.js'
import { verifyAlgorand, type AlgorandReader, type AlgorandTxRecord } from './verify.js'
import {
  assertAlgorandWallet,
  resolveAlgorandWallet,
  type AlgorandWalletConfig,
} from './wallet.js'
import {
  ConfirmationTimeoutError,
  UnknownTokenError,
  WrongFamilyError,
} from '../../errors.js'
import { rejectForeignToken } from '../shared.js'
// The spec's truncated mainnet id, owned by `indexes.ts` (which also aliases it to the padded
// form we bind). Imported, never re-typed — a second copy of a genesis hash is a drift bug.
import { ALGORAND_SPEC_CAIP2 } from '../../indexes.js'
import { nativeCost } from '../../util/cost.js'
import type {
  PaymentDriver,
  ResolvedNetwork,
  ResolveOptions,
  ResolvedToken,
  TokenInput,
  WalletBalance,
  WalletHandle,
} from '../types.js'

export const algorandDriver: PaymentDriver = {
  family: 'algorand',
  resolve(opts: ResolveOptions): ResolvedNetwork | null {
    if (opts.chain !== 'algorand') return null
    const algodUrl = opts.rpcUrl ?? ALGORAND_MAINNET.defaultAlgod
    return makeAlgorandNetwork(ALGORAND_MAINNET, algodUrl)
  },
}

function makeAlgorandNetwork(preset: AlgorandPreset, algodUrl: string): ResolvedNetwork {
  // Public AlgoNode endpoints need no token; the empty string + empty port is the
  // documented way to point algosdk at a URL-only provider.
  const algod = new algosdk.Algodv2('', algodUrl, '')
  const indexer = new algosdk.Indexer('', preset.defaultIndexer, '')
  const network = preset.caip2

  // Adapt the algosdk indexer model to the narrow reader the verifier needs, so
  // verify.ts stays unit-testable with a plain mock.
  const reader: AlgorandReader = {
    async transactionsForAccount(account, limit) {
      const res = (await indexer.lookupAccountTransactions(account).limit(limit).do()) as {
        transactions?: unknown[]
      }
      return (res.transactions ?? [])
        .map((t) => adaptTxn(t))
        .filter((r): r is AlgorandTxRecord => r !== null)
    },
  }

  const payClient: AlgorandPayClient = {
    async build(transfer) {
      const suggestedParams = await algod.getTransactionParams().do()
      const common = {
        sender: transfer.sender,
        receiver: transfer.receiver,
        amount: transfer.amount,
        note: transfer.note,
        suggestedParams,
      }
      const txn =
        transfer.assetId === undefined
          ? algosdk.makePaymentTxnWithSuggestedParamsFromObject(common)
          : algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
              ...common,
              assetIndex: transfer.assetId,
            })
      return { txn, txId: txn.txID() }
    },
    async signSend({ txn, sk }) {
      const signed = (txn as { signTxn(sk: Uint8Array): Uint8Array }).signTxn(sk)
      await algod.sendRawTransaction(signed).do()
    },
  }

  // The standard `exact` rail's network ops, adapted from the real algod so exact.ts stays a
  // pure, mockable module. simulate verifies signatures (allow-empty-signatures defaults false);
  // sendRawTransaction concatenates the array into one atomic-group submission.
  const settleClient: AlgorandSettleClient = {
    async simulate(signedGroup) {
      const resp = (await algod.simulateRawTransactions(signedGroup).do()) as {
        txnGroups?: { failureMessage?: string }[]
      }
      const fm = resp?.txnGroups?.[0]?.failureMessage
      return { failureMessage: fm && fm.length > 0 ? fm : null }
    },
    async submit(signedGroup) {
      const res = (await algod.sendRawTransaction(signedGroup).do()) as { txid?: string }
      return res?.txid ?? ''
    },
    async waitForConfirmation(txid) {
      const info = (await algosdk.waitForConfirmation(algod, txid, 10)) as {
        confirmedRound?: bigint | number
      }
      const r = info.confirmedRound
      return r != null && Number(r) > 0 ? Number(r) : null
    },
  }

  return {
    family: 'algorand',
    network,
    // Accept our padded 44-char genesis-hash id AND the spec's 32-char truncated form
    // (`scheme_exact_algo.md`'s Network Identifiers table — the form 874 of the 1,463 live
    // Algorand rails use), so a caller that bypasses `normalizeNetwork` and hands the raw
    // spec id to the driver still matches. Mirrors TON's legacy-id tolerance; the
    // normalizeNetwork alias remains the canonical seam. We still EMIT the padded form —
    // changing that would break every deployed PipRail 2.x buyer, so it waits for a major.
    supports: (n) => n === network || n === ALGORAND_SPEC_CAIP2,

    resolveToken(token: TokenInput): ResolvedToken {
      if (token === 'native') {
        return { asset: 'native', decimals: ALGO_DECIMALS, symbol: ALGO_SYMBOL }
      }
      if (typeof token === 'string') {
        const info = preset.tokens[token.toUpperCase()]
        if (!info) {
          const known = Object.keys(preset.tokens).join(', ') || '(none built in)'
          throw new UnknownTokenError(
            `token "${token}" isn't built in for Algorand (known: ${known}). ` +
              `Pass { assetId, decimals } for a custom ASA, or use 'native'.`
          )
        }
        return { asset: algorandAssetId(info.assetId), decimals: info.decimals, symbol: info.symbol }
      }
      rejectForeignToken(token, 'algorand', network)
      // AlgorandToken { assetId, decimals, symbol? }
      const t = token as { assetId?: number; decimals?: number; symbol?: string }
      if (typeof t.assetId !== 'number' || typeof t.decimals !== 'number') {
        throw new WrongFamilyError(
          `chain ${network} is Algorand; a custom token must be { assetId, decimals }.`
        )
      }
      return {
        asset: algorandAssetId(t.assetId),
        decimals: t.decimals,
        ...(t.symbol ? { symbol: t.symbol } : {}),
      }
    },

    describeAsset(asset: string) {
      if (asset === 'native') return { symbol: ALGO_SYMBOL, decimals: ALGO_DECIMALS }
      for (const info of Object.values(preset.tokens)) {
        if (algorandAssetId(info.assetId) === asset) {
          return { symbol: info.symbol, decimals: info.decimals }
        }
      }
      return null
    },

    assertValidPayTo(payTo: string) {
      if (payTo.startsWith('0x')) {
        throw new WrongFamilyError(
          `chain ${network} is Algorand, but payTo "${payTo}" looks like an EVM address.`
        )
      }
      if (!algosdk.isValidAddress(payTo)) {
        throw new WrongFamilyError(
          `chain ${network} is Algorand, but payTo "${payTo}" is not a valid Algorand address.`
        )
      }
    },

    bindWallet(wallet: unknown): WalletHandle {
      return { _native: assertAlgorandWallet(wallet, network) }
    },

    async send(wallet, accept) {
      const signer = resolveAlgorandWallet(wallet._native as AlgorandWalletConfig)
      return payAlgorand({ client: payClient, sk: signer.sk, sender: signer.addr, accept })
    },

    async confirm(ref) {
      try {
        const info = (await algosdk.waitForConfirmation(algod, ref, 10)) as {
          confirmedRound?: bigint | number
        }
        return { height: String(info.confirmedRound ?? 0) }
      } catch (err) {
        throw new ConfirmationTimeoutError(`Algorand tx ${ref} did not confirm in time.`, {
          cause: err,
        })
      }
    },

    async estimateCost(accept) {
      // Standard `exact` rail: the buyer only SIGNS its asset transfer at fee 0; the fee payer
      // (a keyless facilitator, or the merchant's relayer) pools the group fee and submits — so
      // the BUYER's gas is 0 (mirrors the EVM/Solana drivers). Report it gasless so the planner
      // shows the rail as buyer-gasless and `autoRoute` prefers it over onchain-proof.
      if (accept.scheme === 'exact') {
        return nativeCost({
          symbol: ALGO_SYMBOL,
          decimals: ALGO_DECIMALS,
          fee: 0n,
          basis: 'estimated',
          detail: 'gasless — the fee payer (facilitator/relayer) pools the group fee; the buyer pays 0 ALGO',
        })
      }
      // Algorand's minimum fee is 1000 microAlgos (0.001 ALGO) per transaction —
      // flat and sub-cent. A small heuristic in ALGO (6dp) is honest.
      return nativeCost({
        symbol: ALGO_SYMBOL,
        decimals: ALGO_DECIMALS,
        fee: 1000n,
        basis: 'heuristic',
        detail: 'min fee 1000 µAlgos (1 transaction)',
      })
    },

    async balanceOf(wallet: WalletHandle, asset: string): Promise<WalletBalance> {
      let owner: string
      try {
        owner = resolveAlgorandWallet(wallet._native as AlgorandWalletConfig).addr
      } catch {
        return { token: null, native: null }
      }
      let info: { amount?: bigint | number; assets?: { assetId: bigint | number; amount: bigint | number }[] }
      try {
        info = (await algod.accountInformation(owner).do()) as typeof info
      } catch {
        return { token: null, native: null }
      }
      const native = info.amount != null ? BigInt(info.amount) : null
      if (asset === 'native') return { token: native, native }
      const assetId = parseAlgorandAssetId(asset)
      const holding = (info.assets ?? []).find((a) => Number(a.assetId) === assetId)
      // Not opted in → a genuine 0 (the payer can't hold the ASA without opting in).
      return { token: holding ? BigInt(holding.amount) : 0n, native }
    },

    async recipientReady(payTo: string, asset: string) {
      if (asset === 'native') return { ready: 'n/a' as const } // ALGO needs no opt-in
      const assetId = parseAlgorandAssetId(asset)
      if (assetId == null) return { ready: 'unknown' as const }
      try {
        const info = (await algod.accountInformation(payTo).do()) as {
          assets?: { assetId: bigint | number }[]
        }
        const optedIn = (info.assets ?? []).some((a) => Number(a.assetId) === assetId)
        return optedIn
          ? { ready: true as const }
          : { ready: false as const, reason: 'NOT_OPTED_IN' as const }
      } catch (e) {
        // A non-existent account hasn't opted into anything → must opt in to receive the ASA.
        if (/does not exist|no accounts found|404|account not found/i.test(String((e as Error)?.message ?? e))) {
          return { ready: false as const, reason: 'NOT_OPTED_IN' as const }
        }
        return { ready: 'unknown' as const }
      }
    },

    async verify(_ref, accept) {
      // Re-derive the watched account from the TRUSTED accept (payTo), not the
      // client ref — binding/provenance come from the note + the inbound transfer.
      return verifyAlgorand({ reader, accept })
    },

    // Standard x402 `exact` rail, BUYER side — build the canonical 2-txn group (buyer axfer at
    // fee 0 + the fee payer's pooled-fee pay txn), sign ONLY the axfer (the buyer spends zero
    // ALGO). Never submits. Throws UnsupportedSchemeError for native / a missing feePayer / a
    // feePayer that equals the payer.
    async payExact(wallet: WalletHandle, accept) {
      const signer = resolveAlgorandWallet(wallet._native as AlgorandWalletConfig)
      const suggestedParams = await algod.getTransactionParams().do()
      const { payload, payerFrom, nonce } = await payExactAlgorand({
        suggestedParams,
        sk: signer.sk,
        sender: signer.addr,
        accept,
      })
      return { payload, accepted: accept, payerFrom, nonce }
    },

    // Standard x402 `exact` rail, SELLER side — verify the inbound group against the trusted
    // accept, then co-sign the fee txn as the fee payer + submit the group (self-settle, no
    // facilitator). The buyer stays gasless; the merchant's relayer pays the pooled group fee.
    async settleExactSelf({ relayer, payload, accept }) {
      if (!('paymentGroup' in payload)) {
        // A non-Algorand payload reached the Algorand driver — impossible via the gate's per-spec
        // routing, but fail closed as a client fault rather than crash.
        return { ok: false, error: 'signature_invalid', detail: 'Algorand exact expects a { paymentGroup } payload.' }
      }
      const signer = resolveAlgorandWallet(relayer._native as AlgorandWalletConfig)
      return verifyAndSettleExactAlgorand({
        client: settleClient,
        feePayerSk: signer.sk,
        feePayerAddr: signer.addr,
        payload,
        accept,
      })
    },

    // The gate's rail-advertisement SPI. The fee payer is EITHER a keyless facilitator's sponsor
    // address (`feePayer` — facilitator mode, neither buyer nor merchant pays gas) OR the
    // merchant's own bound `relayer` (self mode); native ALGO isn't exact-payable. `null` ⇒ no
    // exact rail. The buyer fee-pools the group, so the merchant may even reuse `payTo` as the
    // relayer (Algorand allows feePayer === payTo — the fee txn is separate, unlike Solana).
    async resolveExactRail({ asset, relayer, feePayer }) {
      if (asset === 'native') return null
      let fp = feePayer
      if (!fp && relayer) {
        try {
          fp = resolveAlgorandWallet(relayer._native as AlgorandWalletConfig).addr
        } catch {
          return null // a malformed relayer mnemonic can't carry a rail
        }
      }
      if (!fp || !algosdk.isValidAddress(fp)) return null
      return { method: 'algorand', extra: { feePayer: fp } }
    },
  }
}

/** Normalise an algosdk indexer transaction model into the verifier's flat record. */
function adaptTxn(raw: unknown): AlgorandTxRecord | null {
  const t = raw as {
    id?: string
    txType?: string
    roundTime?: number
    note?: Uint8Array
    sender?: unknown
    paymentTransaction?: { receiver?: unknown; amount?: bigint | number }
    assetTransferTransaction?: { receiver?: unknown; amount?: bigint | number; assetId?: bigint | number }
  }
  if (!t || typeof t.id !== 'string') return null
  const note = t.note && t.note.length ? decodeNote(t.note) : undefined
  const base: AlgorandTxRecord = {
    id: t.id,
    txType: String(t.txType ?? ''),
    ...(note !== undefined ? { note } : {}),
    ...(t.sender != null ? { sender: String(t.sender) } : {}),
    ...(typeof t.roundTime === 'number' ? { roundTime: t.roundTime } : {}),
  }
  if (t.paymentTransaction) {
    const pt = t.paymentTransaction
    return {
      ...base,
      txType: 'pay',
      ...(pt.receiver != null ? { receiver: String(pt.receiver) } : {}),
      ...(pt.amount != null ? { amount: String(pt.amount) } : {}),
    }
  }
  if (t.assetTransferTransaction) {
    const att = t.assetTransferTransaction
    return {
      ...base,
      txType: 'axfer',
      ...(att.receiver != null ? { receiver: String(att.receiver) } : {}),
      ...(att.amount != null ? { amount: String(att.amount) } : {}),
      ...(att.assetId != null ? { assetId: Number(att.assetId) } : {}),
    }
  }
  return base
}

function decodeNote(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder().decode(bytes)
  } catch {
    return undefined
  }
}
