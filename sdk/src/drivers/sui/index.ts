/**
 * ── SUI SECTION ──────────────────────────────────────────────────────────
 * The Sui PaymentDriver. Same PaymentDriver contract as the other families;
 * Move coin objects underneath. The registry auto-mounts this file (via the
 * lazy loader in ../index.ts) the first time a Sui chain is used, so
 * `@mysten/sui` loads on demand — other installs never pull it in.
 *
 * USDC is built in (verified on-chain); no native USDT on Sui, so it's absent —
 * pass a custom coin via `{ coinType, decimals }`.
 *
 * Template B (digest-bound, like EVM/Solana): the proof ref is the tx digest;
 * verify() re-derives the watched recipient + coin type from the trusted
 * `accept` (never the client ref) and reads the tx's balance changes. So a
 * persistent isUsed/markUsed store + a tight maxTimeoutSeconds are load-bearing
 * for multi-instance deployments (README §3a). Sui is ~sub-second final.
 */
import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc'
import { isValidSuiAddress } from '@mysten/sui/utils'
import {
  SUI_MAINNET,
  SUI_DECIMALS,
  SUI_SYMBOL,
  type SuiPreset,
} from './chains.js'
import { paySui, type SuiPayClient } from './pay.js'
import { verifySui, type SuiReader, type SuiBalanceChange } from './verify.js'
import { assertSuiWallet, resolveSuiKeypair, type SuiWalletConfig } from './wallet.js'
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

export const suiDriver: PaymentDriver = {
  family: 'sui',
  resolve(opts: ResolveOptions): ResolvedNetwork | null {
    if (opts.chain !== 'sui') return null
    const rpcUrl = opts.rpcUrl ?? SUI_MAINNET.defaultRpc
    return makeSuiNetwork(SUI_MAINNET, rpcUrl)
  },
}

/** Pull a plain address out of a Sui owner field ({ AddressOwner } | …). */
function ownerAddress(owner: unknown): string {
  if (owner && typeof owner === 'object' && 'AddressOwner' in owner) {
    return (owner as { AddressOwner: string }).AddressOwner
  }
  return ''
}

function makeSuiNetwork(preset: SuiPreset, rpcUrl: string): ResolvedNetwork {
  // v2 requires `network` alongside the RPC `url` (used for auxiliary lookups; the
  // caller's `url` remains the JSON-RPC endpoint — verified). Presets are mainnet-only.
  const client = new SuiJsonRpcClient({ url: rpcUrl, network: 'mainnet' })
  const network = preset.caip2

  // Adapt getTransactionBlock to the narrow reader the verifier needs, so
  // verify.ts stays unit-testable with a plain mock.
  const reader: SuiReader = {
    async getTransaction(digest) {
      const tx = await client.getTransactionBlock({
        digest,
        options: { showBalanceChanges: true, showEffects: true },
      })
      if (!tx) return null
      const balanceChanges: SuiBalanceChange[] = (tx.balanceChanges ?? []).map((bc) => ({
        owner: ownerAddress(bc.owner),
        coinType: bc.coinType,
        amount: bc.amount,
      }))
      return {
        status: tx.effects?.status?.status ?? 'unknown',
        timestampMs: tx.timestampMs != null ? Number(tx.timestampMs) : undefined,
        balanceChanges,
      }
    },
  }

  return {
    family: 'sui',
    network,
    supports: (n) => n === network,

    resolveToken(token: TokenInput): ResolvedToken {
      if (token === 'native') {
        return { asset: 'native', decimals: SUI_DECIMALS, symbol: SUI_SYMBOL }
      }
      if (typeof token === 'string') {
        const info = preset.tokens[token.toUpperCase()]
        if (!info) {
          const known = Object.keys(preset.tokens).join(', ') || '(none built in)'
          throw new UnknownTokenError(
            `token "${token}" isn't built in for Sui (known: ${known}). ` +
              `Note: no native USDT on Sui. Pass { coinType, decimals } for a custom coin, or use 'native'.`
          )
        }
        return { asset: info.coinType, decimals: info.decimals, symbol: info.symbol }
      }
      rejectForeignToken(token, 'sui', network)
      // SuiToken { coinType, decimals, symbol? }
      const t = token as { coinType?: string; decimals?: number; symbol?: string }
      if (!t.coinType || typeof t.decimals !== 'number') {
        throw new WrongFamilyError(
          `chain ${network} is Sui; a custom token must be { coinType, decimals }.`
        )
      }
      return {
        asset: t.coinType,
        decimals: t.decimals,
        ...(t.symbol ? { symbol: t.symbol } : {}),
      }
    },

    describeAsset(asset: string) {
      if (asset === 'native') return { symbol: SUI_SYMBOL, decimals: SUI_DECIMALS }
      for (const info of Object.values(preset.tokens)) {
        if (info.coinType === asset) return { symbol: info.symbol, decimals: info.decimals }
      }
      return null
    },

    assertValidPayTo(payTo: string) {
      if (!isValidSuiAddress(payTo)) {
        throw new WrongFamilyError(
          `chain ${network} is Sui, but payTo "${payTo}" is not a valid Sui address (0x + 32 bytes).`
        )
      }
    },

    bindWallet(wallet: unknown): WalletHandle {
      return { _native: assertSuiWallet(wallet, network) }
    },

    async send(wallet, accept) {
      const keypair = resolveSuiKeypair(wallet._native as SuiWalletConfig)
      return paySui({ client: client as unknown as SuiPayClient, keypair, accept })
    },

    async confirm(ref) {
      try {
        const tx = await client.waitForTransaction({ digest: ref, options: { showEffects: true } })
        return { height: String((tx as { checkpoint?: string }).checkpoint ?? '0') }
      } catch (err) {
        throw new ConfirmationTimeoutError(`Sui tx ${ref} did not finalize in time.`, { cause: err })
      }
    },

    async estimateCost() {
      // Sui fees are tiny and storage-rebate-dominated; a small flat heuristic in
      // SUI (9dp) is honest. Most storage cost is rebated on success.
      return nativeCost({
        symbol: SUI_SYMBOL,
        decimals: SUI_DECIMALS,
        fee: 3_000_000n, // ~0.003 SUI
        basis: 'heuristic',
        detail: '≈0.003 SUI (computation + storage; storage is largely rebated on success)',
      })
    },

    async verify(ref, accept) {
      return verifySui({ reader, digest: ref, accept })
    },
  }
}
