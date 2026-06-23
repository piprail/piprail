/**
 * ── TRON SECTION ──────────────────────────────────────────────────────────
 * The Tron PaymentDriver. Same PaymentDriver contract as EVM/Solana/TON/Stellar;
 * TRC-20 tokens underneath. The registry auto-mounts this file (via the lazy
 * loader in ../index.ts) the first time a Tron chain is used, so `tronweb` loads
 * on demand — pure installs for other families never pull it in.
 *
 * USD₮ is built in (verified on-chain). Native USDC does NOT exist on Tron, so
 * it's intentionally absent; pass a custom TRC-20 via `{ address, decimals }`.
 * Native TRX IS a payment asset (`token: 'native'`, 6dp) — a plain TransferContract, digest-bound (see chains.ts).
 *
 * Template B (digest-bound, like EVM/Solana): the proof ref is the txid; binding
 * comes from a single-use proof (the gate's used-set) + recipient + amount +
 * asset + recency. verify() reads the CONFIRMED tx from the solidity node (the
 * finality gate) and re-derives the watched token/recipient from the trusted
 * `accept` (never the client ref). So persistent isUsed/markUsed is recommended
 * for multi-instance deployments, with a tight maxTimeoutSeconds (README §3a).
 */
import { TronWeb } from 'tronweb'
import { TRON_MAINNET, TRX_DECIMALS, type TronPreset } from './chains.js'
import { payTron, payTronNative, type TronPayClient } from './pay.js'
import {
  verifyTron,
  verifyTronNative,
  type TronReader,
  type TronTxInfo,
  type TronRawTx,
} from './verify.js'
import { assertTronWallet, resolveTronPrivateKey, type TronWalletConfig } from './wallet.js'
import {
  ConfirmationTimeoutError,
  UnknownTokenError,
  WrongFamilyError,
} from '../../errors.js'
import { rejectForeignToken } from '../shared.js'
import { nativeCost } from '../../util/cost.js'
import { delay } from '../../util/async.js'
import type {
  PaymentDriver,
  ResolvedNetwork,
  ResolveOptions,
  ResolvedToken,
  TokenInput,
  WalletBalance,
  WalletHandle,
} from '../types.js'

export const tronDriver: PaymentDriver = {
  family: 'tron',
  resolve(opts: ResolveOptions): ResolvedNetwork | null {
    if (opts.chain !== 'tron') return null
    const rpcUrl = opts.rpcUrl ?? TRON_MAINNET.defaultRpc
    return makeTronNetwork(TRON_MAINNET, rpcUrl)
  },
}

function makeTronNetwork(preset: TronPreset, rpcUrl: string): ResolvedNetwork {
  const tronWeb = new TronWeb({ fullHost: rpcUrl })
  const network = preset.caip2

  /** 20-byte hex (no 41 prefix), lowercase — the form Tron logs carry. */
  function hex20(base58: string): string {
    return tronWeb.address.toHex(base58).replace(/^41/i, '').toLowerCase()
  }

  // Confirmed receipt + logs from the SOLIDITY node = the finality gate.
  const reader: TronReader = {
    async getTransactionInfo(txid) {
      const info = (await tronWeb.trx.getTransactionInfo(txid)) as unknown as TronTxInfo
      if (!info || !info.id) return null
      return info
    },
    // Raw tx (contracts + per-contract ret) for the native-TRX path. getTransaction
    // throws on an unknown tx, so swallow → null; native verify gates finality on
    // getTransactionInfo first anyway.
    async getTransaction(txid) {
      const tx = await tronWeb.trx.getTransaction(txid).catch(() => null)
      const raw = tx as unknown as (TronRawTx & { raw_data?: unknown }) | null
      if (!raw || !raw.raw_data) return null
      return raw
    },
  }

  return {
    family: 'tron',
    network,
    supports: (n) => n === network,

    resolveToken(token: TokenInput): ResolvedToken {
      if (token === 'native') {
        // Native TRX IS a payment asset (digest-bound, like EVM/Solana/Sui): a plain
        // TransferContract, verified by txid + recency + single-use. 6dp (sun).
        return { asset: 'native', decimals: TRX_DECIMALS, symbol: 'TRX' }
      }
      if (typeof token === 'string') {
        const info = preset.tokens[token.toUpperCase()]
        if (!info) {
          const known = Object.keys(preset.tokens).join(', ') || '(none built in)'
          throw new UnknownTokenError(
            `token "${token}" isn't built in for Tron (known: ${known}). ` +
              `Note: native USDC doesn't exist on Tron. Pass { address, decimals } ` +
              `for a custom TRC-20.`
          )
        }
        return { asset: info.address, decimals: info.decimals, symbol: info.symbol }
      }
      rejectForeignToken(token, 'tron', network)
      // TronToken { address, decimals, symbol? } — address is Base58 (T…).
      if (!('address' in token)) {
        throw new WrongFamilyError(
          `chain ${network} is Tron; a custom token must be { address, decimals } (Base58 T… contract).`
        )
      }
      const t = token as { address: string; decimals: number; symbol?: string }
      if (t.address.startsWith('0x') || !tronWeb.isAddress(t.address)) {
        throw new WrongFamilyError(
          `chain ${network} is Tron, but token address "${t.address}" is not a valid Tron contract (T…).`
        )
      }
      return {
        asset: t.address,
        decimals: t.decimals,
        ...(t.symbol ? { symbol: t.symbol } : {}),
      }
    },

    describeAsset(asset: string) {
      if (asset === 'native') return { symbol: 'TRX', decimals: TRX_DECIMALS }
      for (const info of Object.values(preset.tokens)) {
        if (info.address === asset) return { symbol: info.symbol, decimals: info.decimals }
      }
      return null
    },

    assertValidPayTo(payTo: string) {
      if (payTo.startsWith('0x')) {
        throw new WrongFamilyError(
          `chain ${network} is Tron, but payTo "${payTo}" looks like an EVM address.`
        )
      }
      if (!tronWeb.isAddress(payTo)) {
        throw new WrongFamilyError(
          `chain ${network} is Tron, but payTo "${payTo}" is not a valid Tron address (T…).`
        )
      }
    },

    bindWallet(wallet: unknown): WalletHandle {
      return { _native: assertTronWallet(wallet, network) }
    },

    async send(wallet, accept) {
      const privateKey = resolveTronPrivateKey(wallet._native as TronWalletConfig)
      const from = tronWeb.address.fromPrivateKey(privateKey)
      if (!from) {
        throw new WrongFamilyError('Tron wallet { key } could not derive an address.')
      }
      if (accept.asset === 'native') {
        return payTronNative({ client: tronWeb as unknown as TronPayClient, from, privateKey, accept })
      }
      return payTron({
        client: tronWeb as unknown as TronPayClient,
        from,
        privateKey,
        tokenAddress: accept.asset,
        accept,
      })
    },

    async confirm(ref) {
      // Tron finality = solidification (~19 blocks). Poll the solidity node until
      // the confirmed info appears, then surface the block it landed in.
      const txid = ref
      for (let i = 0; i < 30; i += 1) {
        try {
          const info = await reader.getTransactionInfo(txid)
          if (info) return { height: String(info.blockNumber ?? 0) }
        } catch {
          /* transient — keep polling */
        }
        await delay(2500)
      }
      throw new ConfirmationTimeoutError(`Tron tx ${txid} did not solidify in time.`)
    },

    async estimateCost(accept, opts) {
      // Native TRX: a plain TransferContract is just bandwidth (~268 bytes ≈ 0.27 TRX
      // when unstaked), plus a ~1 TRX account-creation fee if the recipient is new.
      if (accept.asset === 'native') {
        return nativeCost({
          symbol: 'TRX',
          decimals: TRX_DECIMALS,
          fee: 1_300_000n,
          basis: 'heuristic',
          detail: '≈0.27 TRX bandwidth (sender unstaked) + up to ~1 TRX if the recipient account is new',
        })
      }
      // A TRC-20 transfer burns Energy + Bandwidth, paid in TRX when the sender
      // isn't staked — the one chain here where gas is materially expensive, so
      // the estimate is genuinely useful. Energy price is a governance param
      // (default 420 sun/energy); bandwidth ~345 bytes × 1000 sun/byte.
      const ENERGY_PRICE = 420n
      const BANDWIDTH_SUN = 345_000n
      // Precise: estimate the actual energy via a constant call when we know the
      // payer (energy depends on whether the recipient already holds the token).
      if (opts?.from) {
        try {
          const r = (await tronWeb.transactionBuilder.triggerConstantContract(
            accept.asset,
            'transfer(address,uint256)',
            {},
            [
              { type: 'address', value: accept.payTo },
              { type: 'uint256', value: accept.amount },
            ],
            opts.from
          )) as { energy_used?: number }
          const energy = BigInt(r.energy_used ?? 0)
          if (energy > 0n) {
            return nativeCost({
              symbol: 'TRX',
              decimals: TRX_DECIMALS,
              fee: energy * ENERGY_PRICE + BANDWIDTH_SUN,
              basis: 'estimated',
              detail: `energy ${energy} @ ${ENERGY_PRICE} sun + bandwidth`,
            })
          }
        } catch {
          /* fall through to the heuristic */
        }
      }
      // Heuristic: a USD₮ transfer is ~30k energy when the sender isn't staked.
      return nativeCost({
        symbol: 'TRX',
        decimals: TRX_DECIMALS,
        fee: 30_000n * ENERGY_PRICE + BANDWIDTH_SUN,
        basis: 'heuristic',
        detail: '~30k energy + bandwidth (sender not staked; pass { from } for a precise estimate)',
      })
    },

    async balanceOf(wallet: WalletHandle, asset: string): Promise<WalletBalance> {
      const owner = tronWeb.address.fromPrivateKey(
        resolveTronPrivateKey(wallet._native as TronWalletConfig)
      )
      if (!owner) return { token: null, native: null }
      const native = await tronWeb.trx
        .getBalance(owner)
        .then((n) => BigInt(n))
        .catch(() => null)
      if (asset === 'native') return { token: native, native }
      let token: bigint | null = null
      try {
        tronWeb.setAddress(owner)
        const res = (await tronWeb.transactionBuilder.triggerConstantContract(
          asset,
          'balanceOf(address)',
          {},
          [{ type: 'address', value: owner }],
          owner
        )) as { constant_result?: string[] }
        const hex = res?.constant_result?.[0]
        token = hex == null ? null : BigInt('0x' + hex)
      } catch {
        token = null
      }
      return { token, native }
    },

    // No receive prerequisite — any Tron account receives TRX/TRC-20 immediately.
    async recipientReady() {
      return { ready: 'n/a' as const }
    },

    async verify(ref, accept) {
      // Use the ref VERBATIM as the txid — never strip/normalize it here. The gate reserves the
      // replay-claim key from this exact ref (server.ts claimTx), so if verify() read a different
      // (e.g. prefix-stripped) identity, `txHash:"X"` and `txHash:"tron:X"` would claim two keys
      // yet verify the SAME on-chain tx → a double-redeem. send()/pay.ts always emits a bare txid.
      const txid = ref
      // Native TRX: the value/recipient live in the tx's TransferContract (no event
      // log), addressed in 0x41-prefixed hex — re-derived from the trusted accept.
      if (accept.asset === 'native') {
        return verifyTronNative({
          reader,
          accept,
          txid,
          payToHex41: tronWeb.address.toHex(accept.payTo).toLowerCase(),
          toBase58: (h) => tronWeb.address.fromHex(h),
        })
      }
      // TRC-20: re-derive the watched token + recipient from the TRUSTED accept, in
      // the 20-byte hex form Tron logs carry — never the client ref.
      return verifyTron({
        reader,
        accept,
        txid,
        tokenHex20: hex20(accept.asset),
        payToHex20: hex20(accept.payTo),
        toBase58: (h) => tronWeb.address.fromHex(`41${h}`),
      })
    },
  }
}

