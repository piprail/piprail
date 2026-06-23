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
import { readExactDomain, verifyAndSettleExactEvm, payExactEvm, resolveExactRailEvm } from './exact.js'
import { payPermit2Evm, verifyAndSettlePermit2Evm, isPermit2ProxyChain } from './permit2.js'
import { payUptoEvm, verifyAndSettleUptoEvm, resolveUptoRailEvm, isUptoProxyChain } from './upto.js'
import { signReceiptEvm } from './receipt.js'
import { networkForChain, chainIdFromNetwork } from '../../x402.js'
import {
  ConfirmationTimeoutError,
  InsufficientFundsError,
  UnknownTokenError,
  UnsupportedNetworkError,
  WrongFamilyError,
  toInsufficientFundsError,
} from '../../errors.js'
import { rejectForeignToken } from '../shared.js'
import { assertNoLegacyWalletKey } from '../wallet-migrate.js'
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
    // A string the registry routed here IS meant to be EVM — surface resolveChain's helpful
    // "unknown chain … built-in names" guidance, but as the TYPED UnsupportedNetworkError (stable
    // `.code === 'UNSUPPORTED_NETWORK'`, `instanceof PipRailError`) the two-channel contract
    // mandates — never a raw chain Error (ERRORS.md §5). The message is preserved verbatim.
    if (typeof opts.chain === 'string') {
      try {
        return makeEvmNetwork(resolveChain(opts.chain as ChainInput, opts.rpcUrl))
      } catch (err) {
        throw new UnsupportedNetworkError(err instanceof Error ? err.message : String(err), { cause: err })
      }
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
      // Validate the address HERE (like assertValidPayTo / the Tron driver), so a non-0x asset (e.g.
      // a Tron `T…` string — which rejectForeignToken can't catch, since EVM+Tron share the
      // `address` key) surfaces as a typed WrongFamilyError at config time, not as a raw viem
      // InvalidAddressError later on the never-throw verify() path. Checksum-normalize at the boundary.
      if (!isAddress(token.address)) {
        throw new WrongFamilyError(
          `chain ${network} is EVM, but token address "${token.address}" is not a valid 0x address.`
        )
      }
      return {
        asset: getAddress(token.address),
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
      if (typeof wallet !== 'object' || wallet === null) {
        throw new WrongFamilyError(
          `chain ${network} is EVM; wallet must be { key } (0x… hex) or { walletClient }.`
        )
      }
      assertNoLegacyWalletKey(wallet, 'EVM')
      if (!('key' in wallet) && !('walletClient' in wallet)) {
        throw new WrongFamilyError(
          `chain ${network} is EVM; wallet must be { key } (0x… hex) or { walletClient }.`
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
      // Standard `exact` rail — AND the metered `upto` rail — are buyer-gasless: the buyer only
      // SIGNS an authorization (EIP-3009 or Permit2) and the server / merchant-chosen facilitator
      // broadcasts it, so the BUYER spends ~0 gas. Report a gasless estimate so the planner never
      // blocks/over-charges native funds. The client already treats BOTH schemes as gasless
      // (`isExact = scheme==='exact' || scheme==='upto'`, client.ts analyzeRail) — this keeps the
      // surfaced cost consistent with that (mirrors the same fix made for NEAR's exact rail).
      if (accept.scheme === 'exact' || accept.scheme === 'upto') {
        // Optional-chain `extra`: a hostile/malformed 402 may offer an exact rail for a
        // RECOGNISED token (so it survives the gather) yet omit the `extra` block entirely.
        // estimateCost is a never-throw read (ERRORS.md) — a missing method just means we
        // can't name the permit2 caveat, still gasless (fee 0). Never a raw TypeError.
        const m = accept.extra?.assetTransferMethod
        const permit2 = m === 'permit2' || m === 'permit2-exact' || m === 'permit2-upto'
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

    // Tier-2 service-delivery attestation (EVM-only) — sign the official offer-receipt
    // EIP-712 RECEIPT_TYPES with the bound (payTo) wallet. Chain-independent (domain
    // chainId is hardcoded 1); viem lives in ./receipt.ts (a lazy chunk).
    signReceipt(wallet: WalletHandle, input) {
      return signReceiptEvm(wallet, input)
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
    // `permit2-exact` is Binance b402's foreign-dialect alias for `permit2` — treated identically.
    // Throws UnsupportedSchemeError for a contract signer (or a non-EIP-3009 token on the eip3009 path).
    async payExact(wallet: WalletHandle, accept) {
      const a = wallet._native as WalletAdapter
      const method = accept.extra.assetTransferMethod
      if (method === 'permit2' || method === 'permit2-exact') {
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

    // The gate's rail-advertisement SPI — EIP-3009 vs Permit2 selection (the pure helper),
    // injecting the on-chain domain read + the Permit2 proxy-presence check.
    async resolveExactRail({ asset, method }) {
      return resolveExactRailEvm({
        asset,
        method,
        readDomain: (a) => readExactDomain(publicClient, a),
        permit2Supported: () => isPermit2ProxyChain(resolved.chainId),
      })
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
      if ('transaction' in payload) {
        // An SVM-shaped payload reached the EVM driver — impossible via the gate's per-spec
        // routing, but fail closed as a client fault rather than crash.
        return { ok: false, error: 'signature_invalid', detail: 'An SVM (Solana) payload was submitted to an EVM exact rail.' }
      }
      if ('paymentGroup' in payload) {
        // An Algorand-shaped payload reached the EVM driver — impossible via per-spec routing; fail closed.
        return { ok: false, error: 'signature_invalid', detail: 'An Algorand payload was submitted to an EVM exact rail.' }
      }
      if ('signedDelegateAction' in payload) {
        // A NEAR-shaped payload reached the EVM driver — impossible via per-spec routing; fail closed.
        return { ok: false, error: 'signature_invalid', detail: 'A NEAR payload was submitted to an EVM exact rail.' }
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

    // Standard x402 `upto` (metered) rail — EVM-Permit2 ONLY. The metered sibling of the
    // exact trio. resolveUptoRail advertises (Permit2-only, proxy-gated, relayer = facilitator);
    // payUpto signs the MAX with witness.facilitator bound; settleUptoSelf self-settles the actual.
    async resolveUptoRail({ asset, relayer }) {
      const relayerAddress = (relayer._native as WalletAdapter).account.address
      // The token's EIP-712 domain rides along for the optional EIP-2612 extension (best-effort).
      const domain = asset === 'native' ? null : await readExactDomain(publicClient, asset).catch(() => null)
      return resolveUptoRailEvm({
        asset,
        relayerAddress,
        proxySupported: () => isUptoProxyChain(resolved.chainId),
        domain,
      })
    },

    async payUpto(wallet: WalletHandle, accept) {
      const a = wallet._native as WalletAdapter
      const { payload, payerFrom, nonce } = await payUptoEvm({
        publicClient,
        walletClient: a.walletClient,
        account: a.account,
        chainId: resolved.chainId,
        chain: resolved.chain,
        accept,
      })
      return { payload, accepted: accept, payerFrom, nonce }
    },

    async settleUptoSelf({ relayer, payload, accept, settleAmount }) {
      const a = relayer._native as WalletAdapter
      return verifyAndSettleUptoEvm({
        publicClient,
        walletClient: a.walletClient,
        account: a.account,
        chain: resolved.chain,
        payload,
        accept,
        settleAmount,
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
