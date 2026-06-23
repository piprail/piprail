/**
 * ── SOLANA SECTION ──────────────────────────────────────────────────────
 * The Solana PaymentDriver. Same contract as the EVM driver; different chain
 * underneath. The registry auto-mounts this file (via the lazy loader in
 * ../index.ts) the first time a Solana chain is used, so `@solana/web3.js` is
 * loaded on demand — pure-EVM consumers never pull it in.
 */
import { Connection, Keypair, PublicKey } from '@solana/web3.js'
import {
  getAccount,
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
  TokenAccountNotFoundError,
} from '@solana/spl-token'
import { SOLANA_MAINNET, SOL_DECIMALS, type SolanaPreset } from './chains.js'
import { paySolana } from './pay.js'
import { verifySolana } from './verify.js'
import { payExactSolana, verifyAndSettleExactSolana } from './exact.js'
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
  WalletBalance,
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
      // Standard `exact` rail: the buyer only SIGNS; the fee payer (a facilitator like PayAI, or the
      // merchant's relayer) broadcasts and pays the SOL fee — and the canonical exact tx creates no
      // account — so the BUYER's gas is ~0. Report it gasless (mirrors the EVM driver) so the planner
      // shows the rail as buyer-gasless and `autoRoute` prefers it over the gas-paying onchain-proof rail.
      if (accept.scheme === 'exact') {
        return nativeCost({
          symbol: 'SOL',
          decimals: SOL_DECIMALS,
          fee: 0n,
          basis: 'estimated',
          detail: 'gasless — the fee payer (facilitator/relayer) broadcasts and pays the SOL fee',
        })
      }
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

    async balanceOf(wallet: WalletHandle, asset: string): Promise<WalletBalance> {
      const owner = (wallet._native as Keypair).publicKey
      const native = await connection
        .getBalance(owner)
        .then((n) => BigInt(n))
        .catch(() => null)
      if (asset === 'native') return { token: native, native }
      let token: bigint | null
      try {
        const ata = getAssociatedTokenAddressSync(new PublicKey(asset), owner)
        token = (await getAccount(connection, ata, 'confirmed')).amount
      } catch (e) {
        // No token account yet = a genuine 0; any other read failure = unknown.
        token = e instanceof TokenAccountNotFoundError ? 0n : null
      }
      return { token, native }
    },

    // No receive prerequisite for the DEFAULT onchain-proof rail — the payer's tx idempotently
    // creates the recipient's ATA (pay.ts). KNOWN LIMITATION (documented, not a bug): on the opt-in
    // `exact` rail the buyer cannot create the ATA (payExactSolana throws if payTo's token account
    // is missing), so `planPayment`/`canAfford` can be OPTIMISTIC for an exact payment to a
    // brand-new recipient whose ATA doesn't yet exist — marked payable, and `autoRoute` would pick
    // it then refuse (pre-broadcast, recoverable) at pay time. Mitigations in practice: onchain-proof
    // is always co-offered (and DOES create the ATA), `exact` + `autoRoute` are both off by default,
    // and most merchant receive accounts already exist. 'n/a' is correct for onchain-proof; an
    // exact-aware probe needs the token-program-correct ATA derivation (an extra mint-owner read)
    // and is deferred as disproportionate to this opt-in edge.
    async recipientReady() {
      return { ready: 'n/a' as const }
    },

    async verify(ref, accept) {
      return verifySolana({ connection, signature: ref, accept })
    },

    // Standard x402 `exact` rail, BUYER side — partial-sign an SPL TransferChecked with the
    // merchant as fee payer (the buyer spends zero SOL). Never broadcasts. Throws
    // UnsupportedSchemeError for native / a missing feePayer / feePayer === payTo.
    async payExact(wallet: WalletHandle, accept) {
      const { payload, payerFrom, nonce } = await payExactSolana({
        connection,
        keypair: wallet._native as Keypair,
        accept,
      })
      return { payload, accepted: accept, payerFrom, nonce }
    },

    // Standard x402 `exact` rail, SELLER side — verify the partial-signed tx against the
    // trusted accept, then co-sign as the fee payer + broadcast (self-settle, no facilitator).
    async settleExactSelf({ relayer, payload, accept }) {
      if (!('transaction' in payload)) {
        // An EVM-shaped (eip3009/permit2) payload reached the Solana driver — impossible via the
        // gate's per-spec routing, but fail closed as a client fault rather than crash.
        return { ok: false, error: 'signature_invalid', detail: 'SVM exact expects a { transaction } payload.' }
      }
      return verifyAndSettleExactSolana({
        connection,
        feePayerKeypair: relayer._native as Keypair,
        payload,
        accept,
      })
    },

    // The gate's rail-advertisement SPI. The SVM fee payer is EITHER a facilitator's sponsor
    // pubkey (`feePayer` — facilitator mode, neither buyer nor merchant pays gas) OR the
    // merchant's own bound `relayer` (self mode); native isn't exact-payable. Reads the mint's
    // owner once to flag token-2022 (so both ends derive the same ATA). `null` ⇒ no exact rail.
    async resolveExactRail({ asset, relayer, feePayer }) {
      if (asset === 'native') return null
      const fp = feePayer ?? (relayer ? (relayer._native as Keypair).publicKey.toBase58() : undefined)
      if (!fp) return null // need a facilitator fee payer OR a self-settle relayer
      try {
        // eslint-disable-next-line no-new
        new PublicKey(fp)
      } catch {
        return null // a malformed facilitator/relayer fee-payer can't carry a rail
      }
      let tokenProgram: 'spl-token' | 'token-2022' = 'spl-token'
      try {
        const info = await connection.getAccountInfo(new PublicKey(asset))
        if (info?.owner.equals(TOKEN_2022_PROGRAM_ID)) tokenProgram = 'token-2022'
      } catch {
        /* default spl-token (the built-ins are classic); a wrong guess fails verification cleanly */
      }
      return { method: 'svm', extra: { feePayer: fp, tokenProgram } }
    },
  }
}
