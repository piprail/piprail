/**
 * ── EVM SECTION ──────────────────────────────────────────────────────────
 * The EVM PaymentDriver: one driver, every EVM chain (Base, BNB, Ethereum,
 * Avalanche, Polygon, …). Wraps the existing viem-based code in this folder
 * — chains.ts / wallet.ts / pay.ts / verify.ts — with NO behavior
 * change. This adapter is the only file the registry imports.
 */
import { BaseError, createPublicClient, erc20Abi, getAddress, http, isAddress, type PublicClient } from 'viem'
import { resolveChain, type ChainInput, type ResolvedChain } from './chains.js'
import {
  createWalletAdapter,
  type WalletAdapter,
  type WalletConfig,
} from './wallet.js'
import { payEvm } from './pay.js'
import { verifyEvm } from './verify.js'
import { readExactDomain, verifyAndSettleExactEvm, payExactEvm } from './exact.js'
import { payPermit2Evm, verifyAndSettlePermit2Evm, isPermit2ProxyChain } from './permit2.js'
import { networkForChain, chainIdFromNetwork } from '../../x402.js'
import {
  ConfirmationTimeoutError,
  InsufficientFundsError,
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
  WalletBalance,
  WalletHandle,
} from '../types.js'

export const evmDriver: PaymentDriver = {
  family: 'evm',
  resolve(opts: ResolveOptions): ResolvedNetwork | null {
    // Defer obvious non-EVM inputs so the registry can try another driver.
    if (typeof opts.chain === 'string' && /^(solana|ton|stellar)/.test(opts.chain)) return null
    // A string the registry routed here IS meant to be EVM — let resolveChain's
    // helpful "unknown chain … built-in names" error surface, don't swallow it.
    if (typeof opts.chain === 'string') {
      return makeEvmNetwork(resolveChain(opts.chain as ChainInput, opts.rpcUrl))
    }
    let resolved: ResolvedChain
    try {
      resolved = resolveChain(opts.chain as ChainInput, opts.rpcUrl)
    } catch {
      return null
    }
    return makeEvmNetwork(resolved)
  },
}

function makeEvmNetwork(resolved: ResolvedChain): ResolvedNetwork {
  const network = networkForChain(resolved.chainId)
  const publicClient: PublicClient = createPublicClient({
    chain: resolved.chain,
    transport: http(resolved.rpcUrl),
  })

  return {
    family: 'evm',
    network,
    supports: (n) => chainIdFromNetwork(n) === resolved.chainId,

    resolveToken(token: TokenInput): ResolvedToken {
      if (token === 'native') {
        return {
          asset: 'native',
          decimals: resolved.chain.nativeCurrency.decimals,
          symbol: resolved.chain.nativeCurrency.symbol,
        }
      }
      if (typeof token === 'string') {
        const info = resolved.tokens[token.toUpperCase()]
        if (!info) {
          const known = Object.keys(resolved.tokens).join(', ') || '(none built in)'
          throw new UnknownTokenError(
            `token "${token}" isn't built in for ${resolved.chain.name} ` +
              `(known: ${known}). Pass { address, decimals } instead, or use 'native'.`
          )
        }
        return { asset: info.address, decimals: info.decimals, symbol: info.symbol }
      }
      rejectForeignToken(token, 'evm', network)
      if (!('address' in token)) {
        throw new WrongFamilyError(
          `chain ${network} is EVM; a custom token must be { address, decimals }.`
        )
      }
      return {
        asset: token.address,
        decimals: token.decimals,
        ...(token.symbol ? { symbol: token.symbol } : {}),
      }
    },

    describeAsset(asset: string) {
      if (asset === 'native') {
        return {
          symbol: resolved.chain.nativeCurrency.symbol,
          decimals: resolved.chain.nativeCurrency.decimals,
        }
      }
      let normalized: string
      try {
        normalized = getAddress(asset)
      } catch {
        return null // not a parseable address → unrecognised
      }
      for (const info of Object.values(resolved.tokens)) {
        if (getAddress(info.address) === normalized) {
          return { symbol: info.symbol, decimals: info.decimals }
        }
      }
      return null
    },

    assertValidPayTo(payTo: string) {
      if (!isAddress(payTo)) {
        throw new WrongFamilyError(
          `chain ${network} is EVM, but payTo "${payTo}" is not a valid 0x address.`
        )
      }
    },

    bindWallet(wallet: unknown): WalletHandle {
      if (
        typeof wallet !== 'object' ||
        wallet === null ||
        (!('privateKey' in wallet) && !('walletClient' in wallet))
      ) {
        throw new WrongFamilyError(
          `chain ${network} is EVM; wallet must be { privateKey } or { walletClient }.`
        )
      }
      return { _native: createWalletAdapter(wallet as WalletConfig, resolved) }
    },

    async send(wallet: WalletHandle, accept) {
      const a = wallet._native as WalletAdapter
      try {
        return await payEvm({
          walletClient: a.walletClient,
          account: a.account,
          chain: resolved.chain,
          accept,
        })
      } catch (err) {
        // viem exposes a STRUCTURED insufficient-funds signal; the message case
        // falls through to the shared matcher so the vocabulary can't drift.
        if (isViemInsufficientFunds(err)) {
          throw new InsufficientFundsError(
            err instanceof Error ? err.message : 'Insufficient funds for payment.',
            { cause: err }
          )
        }
        throw toInsufficientFundsError(err) ?? err
      }
    },

    async confirm(ref, minConfirmations) {
      try {
        const receipt = await publicClient.waitForTransactionReceipt({
          hash: ref as `0x${string}`,
          confirmations: minConfirmations,
        })
        return { height: receipt.blockNumber.toString() }
      } catch (err) {
        throw new ConfirmationTimeoutError(
          `EVM tx ${ref} did not reach ${minConfirmations} confirmation(s) in time.`,
          { cause: err }
        )
      }
    },

    async estimateCost(accept) {
      const { decimals, symbol } = resolved.chain.nativeCurrency
      // Standard `exact` rail: the buyer SIGNS an EIP-3009 authorization and the
      // server / merchant-chosen facilitator broadcasts it — so the BUYER spends ~0
      // gas. Report a gasless estimate so the planner never blocks it on native funds.
      if (accept.scheme === 'exact') {
        const permit2 = accept.extra.assetTransferMethod === 'permit2'
        return nativeCost({
          symbol,
          decimals,
          fee: 0n,
          basis: 'estimated',
          detail: permit2
            ? 'gasless after a one-time Permit2 approval; the server/facilitator settles the signed authorization'
            : 'gasless — the server/facilitator settles the signed authorization',
        })
      }
      // Typical gas for a simple transfer: ~21k native, ~65k ERC-20.
      const gasLimit = accept.asset === 'native' ? 21_000n : 65_000n
      try {
        const gasPrice = await publicClient.getGasPrice()
        return nativeCost({
          symbol,
          decimals,
          fee: gasPrice * gasLimit,
          basis: 'estimated',
          detail: `~${gasLimit} gas @ ${gasPrice} wei/gas`,
        })
      } catch {
        const gasPrice = 5_000_000_000n // 5 gwei fallback
        return nativeCost({
          symbol,
          decimals,
          fee: gasPrice * gasLimit,
          basis: 'heuristic',
          detail: `~${gasLimit} gas @ assumed 5 gwei (live gas price unavailable)`,
        })
      }
    },

    async balanceOf(wallet: WalletHandle, asset: string): Promise<WalletBalance> {
      const owner = (wallet._native as WalletAdapter).account.address
      const native = await publicClient.getBalance({ address: owner }).catch(() => null)
      if (asset === 'native') return { token: native, native }
      let token: bigint | null = null
      try {
        token = (await publicClient.readContract({
          address: getAddress(asset),
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [owner],
        })) as bigint
      } catch {
        token = null
      }
      return { token, native }
    },

    // No receive prerequisite — any 0x address receives native or ERC-20 immediately.
    async recipientReady() {
      return { ready: 'n/a' as const }
    },

    // Discovery only (ownership proofs / SIWX) — never the payment path. Signs
    // through the wallet client so it works for both { privateKey } (local) and
    // bring-your-own { walletClient } (JSON-RPC) accounts. eip191 → recoverable
    // with viem's recoverMessageAddress (how x402scan verifies origin ownership).
    discoverySigner(wallet: WalletHandle) {
      const a = wallet._native as WalletAdapter
      return {
        address: a.account.address,
        signMessage: (message: string) =>
          a.walletClient.signMessage({ account: a.account, message }),
      }
    },

    async verify(ref, accept) {
      return verifyEvm({
        publicClient,
        txHash: ref as `0x${string}`,
        accept,
        minConfirmations: accept.extra.minConfirmations,
      })
    },

    // Standard x402 `exact` rail, BUYER side — EVM only. Routes on the rail's
    // `assetTransferMethod`: `permit2` (any ERC-20 — e.g. Binance-Peg USDC on BNB, signs a
    // Permit2 witness transfer + lazily does the one-time approval) or `eip3009` (re-derives
    // the token's EIP-712 domain on-chain + signs transferWithAuthorization). Never broadcasts.
    // Throws UnsupportedSchemeError for a contract signer (or a non-EIP-3009 token on the eip3009 path).
    async payExact(wallet: WalletHandle, accept) {
      const a = wallet._native as WalletAdapter
      if (accept.extra.assetTransferMethod === 'permit2') {
        const { payload, payerFrom, nonce } = await payPermit2Evm({
          publicClient,
          walletClient: a.walletClient,
          account: a.account,
          chainId: resolved.chainId,
          chain: resolved.chain,
          accept,
        })
        return { payload, accepted: accept, payerFrom, nonce }
      }
      const { payload, payerFrom, nonce } = await payExactEvm({
        publicClient,
        walletClient: a.walletClient,
        account: a.account,
        chainId: resolved.chainId,
        accept,
      })
      return { payload, accepted: accept, payerFrom, nonce }
    },

    // Standard x402 `exact` rail (EIP-3009), seller side — EVM only.
    async exactDomain(asset) {
      return readExactDomain(publicClient, asset)
    },

    // Whether the Permit2 transfer method can settle here (proxy deployed). EIP-3009
    // needs no proxy; this only gates the Permit2 fallback for non-EIP-3009 tokens.
    exactPermit2Supported() {
      return isPermit2ProxyChain(resolved.chainId)
    },

    async settleExactSelf({ relayer, payload, accept }) {
      const a = relayer._native as WalletAdapter
      // Route on the PAYLOAD shape (the client's actual signature kind) — a Permit2
      // payload carries `permit2Authorization`, an EIP-3009 one carries `authorization`.
      if ('permit2Authorization' in payload) {
        return verifyAndSettlePermit2Evm({
          publicClient,
          walletClient: a.walletClient,
          account: a.account,
          chain: resolved.chain,
          payload,
          accept,
        })
      }
      return verifyAndSettleExactEvm({
        publicClient,
        walletClient: a.walletClient,
        account: a.account,
        chain: resolved.chain,
        payload,
        accept,
      })
    },
  }
}

/**
 * viem's STRUCTURED "insufficient funds" signal — a nested `InsufficientFundsError`
 * in its error chain. The message-level case is handled by the shared
 * {@link toInsufficientFundsError} in send(), so the two paths can't drift.
 */
function isViemInsufficientFunds(err: unknown): boolean {
  if (err instanceof BaseError) {
    return Boolean(err.walk((e) => e instanceof Error && e.name === 'InsufficientFundsError'))
  }
  return err instanceof Error && err.name === 'InsufficientFundsError'
}
