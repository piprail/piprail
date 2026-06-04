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
  type AlgorandPreset,
} from './chains.js'
import { payAlgorand, type AlgorandPayClient } from './pay.js'
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
import { nativeCost } from '../../util/cost.js'
import type {
  PaymentDriver,
  ResolvedNetwork,
  ResolveOptions,
  ResolvedToken,
  TokenInput,
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

  return {
    family: 'algorand',
    network,
    supports: (n) => n === network,

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

    async estimateCost() {
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

    async verify(_ref, accept) {
      // Re-derive the watched account from the TRUSTED accept (payTo), not the
      // client ref — binding/provenance come from the note + the inbound transfer.
      return verifyAlgorand({ reader, accept })
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
