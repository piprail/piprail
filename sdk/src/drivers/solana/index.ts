/**
 * ── SOLANA SECTION ──────────────────────────────────────────────────────
 * The Solana PaymentDriver. Same contract as the EVM driver; different chain
 * underneath. The registry auto-mounts this file (via the lazy loader in
 * ../index.ts) the first time a Solana chain is used, so `@solana/web3.js` is
 * loaded on demand — pure-EVM consumers never pull it in.
 */
import { Connection, Keypair, PublicKey } from '@solana/web3.js'
import { SOLANA_MAINNET, SOL_DECIMALS, type SolanaPreset } from './chains.js'
import { paySolana } from './pay.js'
import { verifySolana } from './verify.js'
import { toKeypair } from './wallet.js'
import {
  ConfirmationTimeoutError,
  UnknownTokenError,
  WrongFamilyError,
  toInsufficientFundsError,
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

export const solanaDriver: PaymentDriver = {
  family: 'solana',
  resolve(opts: ResolveOptions): ResolvedNetwork | null {
    if (opts.chain !== 'solana') return null
    const rpcUrl = opts.rpcUrl ?? SOLANA_MAINNET.defaultRpc
    return makeSolanaNetwork(SOLANA_MAINNET, rpcUrl)
  },
}

function makeSolanaNetwork(preset: SolanaPreset, rpcUrl: string): ResolvedNetwork {
  const connection = new Connection(rpcUrl, 'confirmed')
  const network = preset.caip2

  return {
    family: 'solana',
    network,
    supports: (n) => n === network,

    resolveToken(token: TokenInput): ResolvedToken {
      if (token === 'native') {
        return { asset: 'native', decimals: SOL_DECIMALS, symbol: 'SOL' }
      }
      if (typeof token === 'string') {
        const info = preset.tokens[token.toUpperCase()]
        if (!info) {
          const known = Object.keys(preset.tokens).join(', ') || '(none built in)'
          throw new UnknownTokenError(
            `token "${token}" isn't built in for Solana (known: ${known}). ` +
              `Pass { mint, decimals } instead, or use 'native'.`
          )
        }
        return { asset: info.mint, decimals: info.decimals, symbol: info.symbol }
      }
      rejectForeignToken(token, 'solana', network)
      if (!('mint' in token)) {
        throw new WrongFamilyError(
          `chain ${network} is Solana; a custom token must be { mint, decimals }.`
        )
      }
      return {
        asset: token.mint,
        decimals: token.decimals,
        ...(token.symbol ? { symbol: token.symbol } : {}),
      }
    },

    describeAsset(asset: string) {
      if (asset === 'native') return { symbol: 'SOL', decimals: SOL_DECIMALS }
      for (const info of Object.values(preset.tokens)) {
        if (info.mint === asset) return { symbol: info.symbol, decimals: info.decimals }
      }
      return null
    },

    assertValidPayTo(payTo: string) {
      if (payTo.startsWith('0x')) {
        throw new WrongFamilyError(
          `chain ${network} is Solana, but payTo "${payTo}" looks like an EVM address.`
        )
      }
      try {
        // eslint-disable-next-line no-new
        new PublicKey(payTo)
      } catch {
        throw new WrongFamilyError(
          `chain ${network} is Solana, but payTo "${payTo}" is not a base58 address.`
        )
      }
    },

    bindWallet(wallet: unknown): WalletHandle {
      return { _native: toKeypair(wallet, network) }
    },

    async send(wallet, accept) {
      try {
        return await paySolana({ connection, keypair: wallet._native as Keypair, accept })
      } catch (err) {
        // Surface "wallet can't afford it" as the same typed error as every
        // other family; anything else propagates unchanged.
        throw toInsufficientFundsError(err) ?? err
      }
    },

    async confirm(ref) {
      // searchTransactionHistory:true so confirm() also works for signatures
      // older than the node's recent-status cache; require real commitment.
      let info
      try {
        const { value } = await connection.getSignatureStatuses([ref], {
          searchTransactionHistory: true,
        })
        info = value[0]
      } catch (err) {
        // Guard the RPC read like every other driver — never leak a raw chain error.
        throw new ConfirmationTimeoutError(
          `Solana payment ${ref} could not be confirmed (RPC read failed).`,
          { cause: err }
        )
      }
      if (
        !info ||
        info.err ||
        (info.confirmationStatus !== 'confirmed' && info.confirmationStatus !== 'finalized')
      ) {
        throw new ConfirmationTimeoutError(`Solana payment ${ref} did not confirm in time.`)
      }
      return { height: String(info.slot) }
    },

    async estimateCost(accept) {
      // The base fee is a fixed 5000 lamports per signature (1 signature here).
      // A token payment may also create the recipient's associated token account
      // (~0.00204 SOL rent) — included conservatively, as we can't tell without
      // an RPC read, and over-estimating gas is the safe direction.
      const base = 5_000n
      if (accept.asset === 'native') {
        return nativeCost({
          symbol: 'SOL',
          decimals: SOL_DECIMALS,
          fee: base,
          basis: 'heuristic',
          detail: '1 signature (5000 lamports)',
        })
      }
      const ataRent = 2_039_280n
      return nativeCost({
        symbol: 'SOL',
        decimals: SOL_DECIMALS,
        fee: base + ataRent,
        basis: 'heuristic',
        detail: '1 signature + recipient token-account rent (~0.00204 SOL, if not already created)',
      })
    },

    async verify(ref, accept) {
      return verifySolana({ connection, signature: ref, accept })
    },
  }
}
