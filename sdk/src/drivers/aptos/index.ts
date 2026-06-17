/**
 * ── APTOS SECTION ─────────────────────────────────────────────────────────
 * The Aptos PaymentDriver. Same PaymentDriver contract as the other families;
 * Move Fungible Assets underneath. The registry auto-mounts this file (via the
 * lazy loader in ../index.ts) the first time an Aptos chain is used, so
 * `@aptos-labs/ts-sdk` loads on demand — other installs never pull it in.
 *
 * BOTH stablecoins are built in (native Circle USDC + native Tether USD₮,
 * verified on-chain) plus native APT — every asset is an FA, transferred via
 * `0x1::primary_fungible_store::transfer` and verified via FA Deposit events.
 *
 * Template B (digest-bound, like Sui/EVM/Solana): the proof ref is the tx hash;
 * verify() re-derives the watched recipient store from the trusted `accept`
 * (never the client ref). So a persistent isUsed/markUsed store + a tight
 * maxTimeoutSeconds are load-bearing for multi-instance deployments (README §3a).
 */
import { Aptos, AptosConfig, Network, AccountAddress } from '@aptos-labs/ts-sdk'
import {
  APTOS_MAINNET,
  APT_DECIMALS,
  APT_SYMBOL,
  type AptosPreset,
} from './chains.js'
import { payAptos, type AptosPayClient } from './pay.js'
import {
  payExactAptos,
  verifyAndSettleExactAptos,
  type AptosExactPayClient,
  type AptosExactSettleClient,
} from './exact.js'
import { verifyAptos, type AptosReader, type AptosDeposit } from './verify.js'
import { assertAptosWallet, resolveAptosAccount, type AptosWalletConfig } from './wallet.js'
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
  WalletBalance,
  WalletHandle,
} from '../types.js'

export const aptosDriver: PaymentDriver = {
  family: 'aptos',
  resolve(opts: ResolveOptions): ResolvedNetwork | null {
    if (opts.chain !== 'aptos') return null
    const rpcUrl = opts.rpcUrl ?? APTOS_MAINNET.defaultRpc
    return makeAptosNetwork(APTOS_MAINNET, rpcUrl)
  },
}

/** Canonical address form (so verify can string-compare stores reliably). */
function norm(addr: string): string {
  try {
    return AccountAddress.from(addr).toString()
  } catch {
    return addr
  }
}

function makeAptosNetwork(preset: AptosPreset, rpcUrl: string): ResolvedNetwork {
  // Presets are mainnet-only; the caller's `rpcUrl` is the REST fullnode endpoint.
  const aptos = new Aptos(new AptosConfig({ network: Network.MAINNET, fullnode: rpcUrl }))
  const network = preset.caip2

  // Adapt the Aptos client to the narrow reader the verifier needs, so verify.ts
  // stays unit-testable with a plain mock.
  const reader: AptosReader = {
    async getTransaction(hash) {
      const tx = (await aptos.getTransactionByHash({ transactionHash: hash })) as {
        type?: string
        success?: boolean
        timestamp?: string
        sender?: string
        events?: { type: string; data: { store?: string; amount?: string | number } }[]
      }
      if (!tx || tx.type !== 'user_transaction') return null
      const deposits: AptosDeposit[] = (tx.events ?? [])
        .filter((e) => e.type === '0x1::fungible_asset::Deposit')
        .map((e) => ({ store: norm(String(e.data.store)), amount: String(e.data.amount) }))
      return {
        success: tx.success === true,
        // Aptos timestamps are microseconds since epoch.
        timestampSeconds: tx.timestamp != null ? Math.floor(Number(tx.timestamp) / 1_000_000) : undefined,
        sender: tx.sender ? norm(String(tx.sender)) : '',
        deposits,
      }
    },
    async primaryStore(owner, metadata) {
      const [addr] = await aptos.view<[string]>({
        payload: {
          function: '0x1::primary_fungible_store::primary_store_address',
          typeArguments: ['0x1::fungible_asset::Metadata'],
          functionArguments: [owner, metadata],
        },
      })
      return norm(String(addr))
    },
  }

  const payClient: AptosPayClient = {
    build: (input) =>
      aptos.transaction.build.simple({
        sender: input.sender,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        data: input.data as any,
        ...(input.options ? { options: input.options } : {}),
      }),
    signSubmit: (input) =>
      aptos.signAndSubmitTransaction({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        signer: input.signer as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        transaction: input.transaction as any,
      }),
  }

  return {
    family: 'aptos',
    network,
    supports: (n) => n === network,

    resolveToken(token: TokenInput): ResolvedToken {
      if (token === 'native') {
        return { asset: 'native', decimals: APT_DECIMALS, symbol: APT_SYMBOL }
      }
      if (typeof token === 'string') {
        const info = preset.tokens[token.toUpperCase()]
        if (!info) {
          const known = Object.keys(preset.tokens).join(', ') || '(none built in)'
          throw new UnknownTokenError(
            `token "${token}" isn't built in for Aptos (known: ${known}). ` +
              `Pass { metadata, decimals } for a custom Fungible Asset, or use 'native'.`
          )
        }
        return { asset: info.metadata, decimals: info.decimals, symbol: info.symbol }
      }
      rejectForeignToken(token, 'aptos', network)
      // AptosToken { metadata, decimals, symbol? }
      const t = token as { metadata?: string; decimals?: number; symbol?: string }
      if (!t.metadata || typeof t.decimals !== 'number') {
        throw new WrongFamilyError(
          `chain ${network} is Aptos; a custom token must be { metadata, decimals }.`
        )
      }
      return {
        asset: t.metadata,
        decimals: t.decimals,
        ...(t.symbol ? { symbol: t.symbol } : {}),
      }
    },

    describeAsset(asset: string) {
      if (asset === 'native') return { symbol: APT_SYMBOL, decimals: APT_DECIMALS }
      for (const info of Object.values(preset.tokens)) {
        if (info.metadata === asset) return { symbol: info.symbol, decimals: info.decimals }
      }
      return null
    },

    assertValidPayTo(payTo: string) {
      // Reject a 20-byte EVM-style hex (AccountAddress.from would otherwise accept
      // it as a short Aptos address) and anything non-hex (Solana base58, etc.).
      const evmLike = /^0x[0-9a-fA-F]{40}$/.test(payTo)
      let valid = false
      try {
        AccountAddress.from(payTo)
        valid = true
      } catch {
        valid = false
      }
      if (!valid || evmLike) {
        throw new WrongFamilyError(
          `chain ${network} is Aptos, but payTo "${payTo}" is not a valid Aptos address (0x + 32 bytes).`
        )
      }
    },

    bindWallet(wallet: unknown): WalletHandle {
      return { _native: assertAptosWallet(wallet, network) }
    },

    async send(wallet, accept) {
      const account = resolveAptosAccount(wallet._native as AptosWalletConfig)
      return payAptos({
        client: payClient,
        signer: account,
        sender: account.accountAddress.toString(),
        accept,
      })
    },

    async confirm(ref) {
      try {
        const tx = await aptos.waitForTransaction({ transactionHash: ref })
        return { height: String((tx as { version?: string }).version ?? '0') }
      } catch (err) {
        throw new ConfirmationTimeoutError(`Aptos tx ${ref} did not finalize in time.`, { cause: err })
      }
    },

    async estimateCost(accept) {
      // Standard `exact` rail: the buyer only SIGNS the sponsored transfer; the fee payer (a keyless
      // facilitator, or the merchant's relayer) adds the fee-payer signature + pays gas — so the
      // BUYER's gas is 0 (mirrors the EVM/Solana/Algorand drivers). Report it gasless so the planner
      // shows the rail as buyer-gasless and `autoRoute` prefers it over onchain-proof.
      if (accept.scheme === 'exact') {
        return nativeCost({
          symbol: APT_SYMBOL,
          decimals: APT_DECIMALS,
          fee: 0n,
          basis: 'estimated',
          detail: 'gasless — the fee payer (facilitator/relayer) sponsors gas; the buyer pays 0 APT',
        })
      }
      // Aptos gas is sub-cent: a simple FA transfer is a few hundred gas units at
      // ~100 octas/unit. A small flat heuristic in APT (8dp) is honest.
      return nativeCost({
        symbol: APT_SYMBOL,
        decimals: APT_DECIMALS,
        fee: 100_000n, // ~0.001 APT
        basis: 'heuristic',
        detail: '≈0.001 APT (a simple Fungible-Asset transfer; Aptos gas is sub-cent)',
      })
    },

    async balanceOf(wallet: WalletHandle, asset: string): Promise<WalletBalance> {
      let owner: string
      try {
        owner = resolveAptosAccount(wallet._native as AptosWalletConfig).accountAddress.toString()
      } catch {
        return { token: null, native: null }
      }
      const native = await aptos
        .getAccountAPTAmount({ accountAddress: owner })
        .then((n) => BigInt(n))
        .catch(() => null)
      if (asset === 'native') return { token: native, native }
      let token: bigint | null = null
      try {
        // FA balance: 0x1::primary_fungible_store::balance(account, metadata).
        const [bal] = await aptos.view<[string | number]>({
          payload: {
            function: '0x1::primary_fungible_store::balance',
            typeArguments: ['0x1::fungible_asset::Metadata'],
            functionArguments: [owner, asset],
          },
        })
        token = BigInt(String(bal))
      } catch {
        token = null
      }
      return { token, native }
    },

    // No receive prerequisite — the recipient's primary FA store auto-creates on receipt.
    async recipientReady() {
      return { ready: 'n/a' as const }
    },

    async verify(ref, accept) {
      return verifyAptos({ reader, hash: ref, accept })
    },

    // Standard x402 `exact` rail, BUYER side — build a fee-payer (sponsored, AIP-39) FA transfer,
    // sign ONLY the sender slot (the buyer spends ZERO APT). Never submits. Throws
    // UnsupportedSchemeError for native / a missing feePayer / a feePayer that equals the payer.
    async payExact(wallet: WalletHandle, accept) {
      const account = resolveAptosAccount(wallet._native as AptosWalletConfig)
      const payClient: AptosExactPayClient = {
        buildFeePayerTransfer: ({ sender, metadata, payTo, amount, maxGasAmount }) =>
          aptos.transaction.build.simple({
            sender,
            withFeePayer: true,
            data: {
              function: '0x1::primary_fungible_store::transfer',
              typeArguments: ['0x1::fungible_asset::Metadata'],
              functionArguments: [metadata, payTo, amount],
            },
            options: { maxGasAmount },
          }),
        signAsSender: ({ transaction }) => aptos.transaction.sign({ signer: account, transaction }),
      }
      const { payload, payerFrom, nonce } = await payExactAptos({
        client: payClient,
        sender: account.accountAddress.toString(),
        accept,
      })
      return { payload, accepted: accept, payerFrom, nonce }
    },

    // Standard x402 `exact` rail, SELLER side — verify the inbound sponsored tx against the trusted
    // accept, then add the fee-payer signature + submit (self-settle, no facilitator). The buyer
    // stays gasless; the merchant's relayer pays gas to receive.
    async settleExactSelf({ relayer, payload, accept }) {
      if (!('senderAuth' in payload) || !('transaction' in payload)) {
        // A non-Aptos payload reached the Aptos driver — impossible via the gate's per-spec routing,
        // but fail closed as a client fault rather than crash.
        return { ok: false, error: 'signature_invalid', detail: 'Aptos exact expects a { transaction, senderAuth } payload.' }
      }
      const feePayerAccount = resolveAptosAccount(relayer._native as AptosWalletConfig)
      const settleClient: AptosExactSettleClient = {
        signAsFeePayer: ({ transaction }) =>
          aptos.transaction.signAsFeePayer({ signer: feePayerAccount, transaction }),
        async simulate({ transaction, senderPublicKey }) {
          const [sim] = await aptos.transaction.simulate.simple({
            signerPublicKey: senderPublicKey,
            feePayerPublicKey: feePayerAccount.publicKey,
            transaction,
          })
          return { success: sim?.success === true, vmStatus: String(sim?.vm_status ?? '') }
        },
        async submit({ transaction, senderAuthenticator, feePayerAuthenticator }) {
          const res = await aptos.transaction.submit.simple({ transaction, senderAuthenticator, feePayerAuthenticator })
          return res.hash
        },
        async waitForConfirmation(hash) {
          try {
            const tx = (await aptos.waitForTransaction({
              transactionHash: hash,
              options: { checkSuccess: false },
            })) as { success?: boolean }
            return { success: tx.success === true }
          } catch {
            return null
          }
        },
      }
      return verifyAndSettleExactAptos({
        client: settleClient,
        feePayerAddr: feePayerAccount.accountAddress.toString(),
        payload,
        accept,
      })
    },

    // The gate's rail-advertisement SPI. The fee payer is EITHER a keyless facilitator's sponsor
    // address (`feePayer`) OR the merchant's own bound `relayer` (self mode); native APT isn't
    // exact-payable. `null` ⇒ no exact rail. Aptos allows feePayer === payTo (the fee-payer
    // signature is separate from the transfer, unlike Solana).
    async resolveExactRail({ asset, relayer, feePayer }) {
      if (asset === 'native') return null
      let fp = feePayer
      if (!fp && relayer) {
        try {
          fp = resolveAptosAccount(relayer._native as AptosWalletConfig).accountAddress.toString()
        } catch {
          return null // a malformed relayer key can't carry a rail
        }
      }
      if (!fp) return null
      try {
        AccountAddress.fromString(fp)
      } catch {
        return null
      }
      return { method: 'aptos', extra: { feePayer: fp } }
    },
  }
}
