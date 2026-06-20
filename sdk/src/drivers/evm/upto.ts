/**
 * ── EVM SECTION: x402 `upto` scheme (Permit2) — BUYER + SELLER ────────────────
 *
 * The metered / variable-amount counterpart to `permit2.ts`. The x402 `upto` scheme lets
 * a buyer authorize a MAXIMUM (sign a Permit2 `PermitWitnessTransferFrom` for the ceiling),
 * and the merchant settle the ACTUAL (≤ max) AFTER serving — billing exactly what was
 * consumed (LLM tokens, bytes, compute). EVM-Permit2 ONLY (the spec bans EIP-3009, which
 * fixes the amount at sign time, and has no non-EVM variant).
 *
 *   • The payer signs an EIP-712 `PermitWitnessTransferFrom` over the canonical **Permit2**
 *     contract, with `spender` = the canonical **x402UptoPermit2Proxy** and a **witness**
 *     `{ to, facilitator, validAfter }` — `facilitator` is the **MIDDLE** field, the one
 *     delta from the exact Permit2 witness. The buyer never broadcasts (and, after a
 *     one-time Permit2 approval, spends ~0 gas) — the merchant broadcasts.
 *   • The merchant SELF-SETTLES by calling the proxy's `settle(permit, amount, owner,
 *     witness, signature)` — `amount` (position 1) is the ACTUAL (≤ the signed max), and the
 *     proxy enforces `msg.sender == witness.facilitator` on-chain (`UnauthorizedFacilitator`)
 *     PLUS `amount <= permit.permitted.amount` (`AmountExceedsPermitted`). So the merchant's
 *     own relayer IS the bound facilitator — backendless, no third-party facilitator.
 *
 * Spec: `specs/schemes/upto/scheme_upto_evm.md` + `contracts/evm/src/x402UptoPermit2Proxy.sol`
 * (witness type string `Witness(address to,address facilitator,uint256 validAfter)` and the
 * `settle(...)` arg order both verdict-confirmed against the cloned source). This module
 * mirrors `permit2.ts` file-for-file (buyer {@link payUptoEvm}; seller
 * {@link verifyAndSettleUptoEvm}); the EVM driver routes to it via the new upto SPI trio.
 *
 * One-time setup is identical to the exact Permit2 rail — the payer `approve(Permit2, max)`
 * ONCE ({@link ensurePermit2Allowance}, re-used from `permit2.ts`).
 *
 * NOT the sponsor-fee-drain class (the relayer broadcasts on EVM and sets gas at broadcast;
 * the buyer's signed witness carries NO fee field) — add NO MAX_FEE cap, exactly like the
 * exact-EIP-3009 / exact-Permit2 rails.
 */
import {
  getAddress,
  recoverTypedDataAddress,
  type Account,
  type Chain,
  type PublicClient,
  type WalletClient,
} from 'viem'
import { SettlementError, UnsupportedSchemeError } from '../../errors.js'
import {
  PERMIT2_ADDRESS,
  PERMIT2_WITNESS_TYPES,
  permit2NonceBitmapAbi,
  ensurePermit2Allowance,
} from './permit2.js'
import type {
  Permit2UptoAuthorization,
  Permit2UptoPaymentPayload,
  VerifyResult,
  X402UptoAcceptEntry,
} from '../../x402.js'

/** Canonical x402UptoPermit2Proxy — the SAME CREATE2 address on every chain where it's been
 *  deployed (see {@link UPTO_PROXY_CHAIN_IDS}; vanity `…0002`, vs the exact proxy's `…0001`).
 *  It is the `spender` the buyer signs over and the contract the seller settles through; it
 *  enforces `transferDetails.to == witness.to`, `msg.sender == witness.facilitator`, and
 *  `amount <= permit.permitted.amount` on-chain. */
export const X402_UPTO_PERMIT2_PROXY = '0x4020A4f3b7b90ccA423B9fabCc0CE57C6C240002' as const

/** EVM chain ids where BOTH the canonical Permit2 AND the x402UptoPermit2Proxy are deployed —
 *  i.e. where the `upto` scheme can actually settle. Verdict-confirmed on-chain (`eth_getCode`,
 *  ~3142-byte byte-identical code, 2026-06-20): Ethereum / Base / Arbitrum / Optimism / Polygon
 *  / BNB. **Avalanche (43114) is NOT deployed (`0x`)** — deliberately OUT. This is INDEPENDENT of
 *  the exact `PERMIT2_PROXY_CHAIN_IDS` (a separate proxy). The proxy is a permissionless CREATE2
 *  deploy, so extend this as it lands on more chains (re-verify each with `eth_getCode` first). */
export const UPTO_PROXY_CHAIN_IDS: ReadonlySet<number> = new Set([
  1, // Ethereum
  8453, // Base
  42161, // Arbitrum
  10, // Optimism
  137, // Polygon
  56, // BNB
])

/** Whether a chain has the x402UptoPermit2Proxy deployed (→ can settle the `upto` scheme). */
export function isUptoProxyChain(chainId: number): boolean {
  return UPTO_PROXY_CHAIN_IDS.has(chainId)
}

/**
 * EIP-712 type set for the x402 `upto` scheme. Identical to {@link PERMIT2_WITNESS_TYPES}
 * (the exact Permit2 rail) EXCEPT the `Witness` struct carries a `facilitator` field as its
 * **MIDDLE** member. MUST encode to exactly the type string the proxy reconstructs:
 *   `PermitWitnessTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline,Witness witness)TokenPermissions(address token,uint256 amount)Witness(address to,address facilitator,uint256 validAfter)`
 * (viem orders referenced structs alphabetically → TokenPermissions before Witness ✓.)
 * **`facilitator` is the MIDDLE field** — get the order wrong and `recoverTypedDataAddress`
 * silently returns the wrong address → every signature rejects. Verdict-confirmed against
 * `x402UptoPermit2Proxy.sol` WITNESS_TYPEHASH + the reference `uptoPermit2WitnessTypes`.
 */
export const PERMIT2_UPTO_WITNESS_TYPES = {
  PermitWitnessTransferFrom: PERMIT2_WITNESS_TYPES.PermitWitnessTransferFrom,
  TokenPermissions: PERMIT2_WITNESS_TYPES.TokenPermissions,
  Witness: [
    { name: 'to', type: 'address' },
    { name: 'facilitator', type: 'address' },
    { name: 'validAfter', type: 'uint256' },
  ],
} as const

/** The upto proxy's `settle(permit, uint256 amount, owner, witness, signature)` — what the
 *  seller broadcasts. The extra `uint256 amount` (the ACTUAL ≤ max) is at **position 1**;
 *  `permit.permitted.amount` stays the signed MAX. The witness tuple carries `facilitator`. */
export const x402UptoProxyAbi = [
  {
    type: 'function',
    name: 'settle',
    stateMutability: 'nonpayable',
    outputs: [],
    inputs: [
      {
        name: 'permit',
        type: 'tuple',
        components: [
          {
            name: 'permitted',
            type: 'tuple',
            components: [
              { name: 'token', type: 'address' },
              { name: 'amount', type: 'uint256' },
            ],
          },
          { name: 'nonce', type: 'uint256' },
          { name: 'deadline', type: 'uint256' },
        ],
      },
      { name: 'amount', type: 'uint256' },
      { name: 'owner', type: 'address' },
      {
        name: 'witness',
        type: 'tuple',
        components: [
          { name: 'to', type: 'address' },
          { name: 'facilitator', type: 'address' },
          { name: 'validAfter', type: 'uint256' },
        ],
      },
      { name: 'signature', type: 'bytes' },
    ],
  },
] as const

/** Shorten a long revert/error message for a `detail` field. */
function shorten(msg: string): string {
  const oneLine = msg.replace(/\s+/g, ' ').trim()
  return oneLine.length > 200 ? `${oneLine.slice(0, 200)}…` : oneLine
}

/** A CSPRNG 256-bit Permit2 nonce (Web Crypto — headless + browser parity). */
function randomPermit2Nonce(): bigint {
  const g = globalThis.crypto
  if (!g?.getRandomValues) {
    throw new UnsupportedSchemeError(
      'this runtime lacks Web Crypto (globalThis.crypto.getRandomValues); the upto rail needs a CSPRNG nonce.'
    )
  }
  const raw = new Uint8Array(32)
  g.getRandomValues(raw)
  return BigInt(`0x${[...raw].map((b) => b.toString(16).padStart(2, '0')).join('')}`)
}

/**
 * BUYER, production path — sign an x402 `upto` payment: a Permit2
 * `PermitWitnessTransferFrom` over `accept.amount` as the MAXIMUM, binding
 * `witness.facilitator = accept.extra.facilitatorAddress` (the MIDDLE witness field).
 * Lazily ensures the one-time Permit2 approval, then EIP-712-signs (spender = the upto
 * proxy, witness.to = the rail's payTo). Returns the wire payload the client frames into
 * `PAYMENT-SIGNATURE`; the merchant settles the proxy `settle` with the metered actual.
 *
 * Re-derives nothing sensitive: `spender` is OUR constant proxy and the EIP-712 domain is
 * Permit2's own — only `token`/`amount`/`payTo`/`facilitator` come from the (server-supplied)
 * accept, and those are exactly what the signature commits to. EOA-only: refuses a contract /
 * EIP-1271 / EIP-7702 signer BEFORE signing.
 */
export async function payUptoEvm(input: {
  publicClient: PublicClient
  walletClient: WalletClient
  account: Account
  chainId: number
  chain: Chain
  accept: X402UptoAcceptEntry
}): Promise<{ payload: Permit2UptoPaymentPayload; payerFrom: string; nonce: string; approvalTx?: string }> {
  const { publicClient, walletClient, account, chainId, chain, accept } = input

  // EOA-only — a contract / EIP-1271 / EIP-7702-delegated account can't produce a
  // recoverable ECDSA signature for our off-chain seller recover. Refuse BEFORE signing
  // (a transient getCode failure is treated as EOA; the seller's simulate is the backstop).
  let code: string | undefined
  try {
    code = await publicClient.getCode({ address: account.address })
  } catch {
    code = undefined
  }
  if (code && code !== '0x') {
    throw new UnsupportedSchemeError(
      `upto buyer rail requires an EOA signer; ${account.address} is a contract / ` +
        `EIP-1271 / EIP-7702-delegated account. Pay via onchain-proof.`
    )
  }

  const facilitatorAddress = accept.extra?.facilitatorAddress
  if (typeof facilitatorAddress !== 'string' || facilitatorAddress.length === 0) {
    throw new UnsupportedSchemeError(
      `upto: the rail carries no extra.facilitatorAddress to bind into witness.facilitator — refusing to sign.`
    )
  }

  const token = getAddress(accept.asset)
  const payTo = getAddress(accept.payTo)
  const facilitator = getAddress(facilitatorAddress)
  const value = BigInt(accept.amount) // the signed MAX, base units (already scaled by decimals)

  // One-time Permit2 approval (gas only on the first ever payment for this token).
  const approvalTx = await ensurePermit2Allowance({
    publicClient,
    walletClient,
    account,
    chain,
    token,
    amount: value,
  })

  const nonce = randomPermit2Nonce()
  const deadline = BigInt(Math.floor(Date.now() / 1000) + accept.maxTimeoutSeconds)
  const validAfter = 0n // the proxy enforces `block.timestamp >= validAfter`; 0 = always active.
  const spender = getAddress(X402_UPTO_PERMIT2_PROXY)
  const from = account.address

  // Sign via the WALLET CLIENT (a bring-your-own JsonRpcAccount's account.signTypedData is undefined).
  const signature = await walletClient.signTypedData({
    account,
    domain: { name: 'Permit2', chainId, verifyingContract: PERMIT2_ADDRESS },
    types: PERMIT2_UPTO_WITNESS_TYPES,
    primaryType: 'PermitWitnessTransferFrom',
    message: {
      permitted: { token, amount: value },
      spender,
      nonce,
      deadline,
      witness: { to: payTo, facilitator, validAfter },
    },
  })

  const permit2Authorization: Permit2UptoAuthorization = {
    permitted: { token, amount: value.toString() },
    from,
    spender,
    nonce: nonce.toString(),
    deadline: deadline.toString(),
    witness: { to: payTo, facilitator, validAfter: validAfter.toString() },
  }
  return {
    payload: { signature, permit2Authorization },
    payerFrom: from,
    nonce: nonce.toString(),
    ...(approvalTx ? { approvalTx } : {}),
  }
}

/**
 * Resolve the EVM `upto` rail descriptor for `asset` — Permit2 ONLY (the spec bans EIP-3009).
 * Returns `null` for native (not metered-payable), a non-proxy chain, or an asset/chain that
 * can't carry Permit2. `extra.facilitatorAddress` is the merchant's own relayer (self-settle
 * only in v1 — the relayer IS the bound facilitator). PURE-ish: injects `proxySupported` so the
 * EVM driver supplies the proxy-presence check and the protocol layer can drive it in tests.
 */
export function resolveUptoRailEvm(input: {
  asset: string
  relayerAddress: string
  proxySupported: () => boolean
  domain?: { name: string; version: string } | null
}): { method: 'permit2-upto'; extra: Record<string, unknown> } | null {
  const { asset, relayerAddress, proxySupported, domain } = input
  if (asset === 'native') return null // native isn't Permit2-transferable → no upto rail
  if (!proxySupported()) return null // no x402UptoPermit2Proxy on this chain → can't settle
  const extra: Record<string, unknown> = { facilitatorAddress: getAddress(relayerAddress) }
  // The token's EIP-712 domain rides along (optional EIP-2612 gas-sponsoring extension), when read.
  if (domain) {
    extra.name = domain.name
    extra.version = domain.version
  }
  return { method: 'permit2-upto', extra }
}

/**
 * SELLER — verify an inbound x402 `upto` payment locally, then SELF-SETTLE the ACTUAL
 * (`settleAmount`, ≤ the signed max) by broadcasting the proxy's `settle(...)` from the
 * merchant's `relayer`. The trusted `accept` (the gate's own rail) is the source of truth for
 * payTo / token / the signed MAX / facilitator; the client's `permit2Authorization` is matched
 * + recovered against it, never trusted. Mirrors {@link verifyAndSettlePermit2Evm}'s contract:
 * `{ ok:false, error }` for a CLIENT-fixable fault (→ 402), `{ ok:true, receipt }` once mined,
 * and THROWS {@link SettlementError} for a SERVER-side broadcast failure (→ 5xx).
 *
 * Upto specifics, all verdict-confirmed against the spec's settle-time logic:
 *  - re-verify the signature against `permitted.amount` (the signed MAX), NEVER the metered
 *    `settleAmount` (verifying against the actual would reject every partial settle);
 *  - clamp/reject `settleAmount > permitted.amount` with `upto_settle_exceeds_max` BEFORE
 *    broadcast (the on-chain `AmountExceedsPermitted` is the second guard);
 *  - `settleAmount === 0n` → a synthetic zero-charge receipt with `transaction: ""`, NO broadcast;
 *  - guard `witness.facilitator === relayer.address` pre-broadcast (the proxy reverts otherwise).
 */
export async function verifyAndSettleUptoEvm(input: {
  publicClient: PublicClient
  walletClient: WalletClient
  account: Account
  chain: Chain
  payload: Permit2UptoPaymentPayload
  accept: X402UptoAcceptEntry
  settleAmount: bigint
}): Promise<VerifyResult> {
  const { publicClient, walletClient, account, chain, payload, accept, settleAmount } = input
  const token = getAddress(accept.asset)
  const payTo = getAddress(accept.payTo)
  const maxAmount = BigInt(accept.amount) // the advertised MAX (the gate's own ceiling)
  const proxy = getAddress(X402_UPTO_PERMIT2_PROXY)
  // The relayer (self-settle) is the bound facilitator — its address is what the buyer MUST
  // have signed into witness.facilitator, and what `msg.sender` will be at broadcast.
  const relayerAddress = getAddress(account.address)

  // --- normalise the client-supplied authorization (validated, not trusted) ---
  let from: `0x${string}`
  let spender: `0x${string}`
  let permittedToken: `0x${string}`
  let witnessTo: `0x${string}`
  let witnessFacilitator: `0x${string}`
  let permittedAmount: bigint
  let nonce: bigint
  let deadline: bigint
  let validAfter: bigint
  const signature = payload.signature
  try {
    const pa = payload.permit2Authorization
    from = getAddress(pa.from)
    spender = getAddress(pa.spender)
    permittedToken = getAddress(pa.permitted.token)
    witnessTo = getAddress(pa.witness.to)
    witnessFacilitator = getAddress(pa.witness.facilitator)
    permittedAmount = BigInt(pa.permitted.amount)
    nonce = BigInt(pa.nonce)
    deadline = BigInt(pa.deadline)
    validAfter = BigInt(pa.witness.validAfter)
    if (!/^0x[0-9a-fA-F]+$/.test(signature)) throw new Error('signature must be hex')
  } catch (err) {
    return {
      ok: false,
      error: 'signature_invalid',
      detail: `Malformed upto authorization: ${err instanceof Error ? err.message : String(err)}.`,
    }
  }

  // --- field checks vs the TRUSTED accept (never the client's echo) ---
  if (witnessTo !== payTo) {
    return { ok: false, error: 'wrong_recipient', detail: `Authorization pays witness.to ${witnessTo}, not ${payTo}.` }
  }
  if (permittedToken !== token) {
    return { ok: false, error: 'signature_invalid', detail: `Authorization permits token ${permittedToken}, not the rail's ${token}.` }
  }
  if (spender !== proxy) {
    return { ok: false, error: 'signature_invalid', detail: `Authorization spender ${spender} is not the x402UptoPermit2Proxy ${proxy}; it can't be settled here.` }
  }
  // The witness MUST bind OUR relayer as the facilitator — only that address can settle on-chain
  // (`UnauthorizedFacilitator`). A mismatch is a client-fixable rejection (the buyer signed for a
  // different facilitator), never a 5xx — reject before broadcast so we never waste a reverting tx.
  if (witnessFacilitator !== relayerAddress) {
    return { ok: false, error: 'signature_invalid', detail: `Authorization binds facilitator ${witnessFacilitator}, not this relayer ${relayerAddress}; only the bound facilitator can settle.` }
  }
  // The signed MAX must EQUAL the rail's advertised ceiling. x402 conformance (scheme_upto_evm
  // §Phase 3 step 4: "permitted.amount equals the amount from requirements"; reference
  // facilitator permit2.ts rejects `permitted.amount !== requirements.amount`). Unlike the exact
  // rail (which settles the fixed amount, so `>=` is safe), upto settles a metered actual UP TO
  // `permitted.amount` — so an OVER-permit (`>` the ceiling) would let a hostile/buggy meter
  // settle MORE than the buyer was shown. Strict equality binds exposure to exactly the advertised
  // max. (PipRail's own buyer signs `accept.amount` verbatim, so this never rejects an honest flow.)
  if (permittedAmount < maxAmount) {
    return { ok: false, error: 'amount_too_low', detail: `Permitted (signed MAX) ${permittedAmount} is below the rail max ${maxAmount}.` }
  }
  if (permittedAmount > maxAmount) {
    return { ok: false, error: 'upto_settle_exceeds_max', detail: `Permitted (signed MAX) ${permittedAmount} exceeds the advertised rail max ${maxAmount}; sign exactly the ceiling.` }
  }
  // Metered actual must NOT exceed the signed MAX — the core upto invariant. Reject BEFORE
  // broadcast (the on-chain `AmountExceedsPermitted` is the redundant second guard). A negative
  // settle amount is a caller bug — reject it too.
  if (settleAmount < 0n) {
    return { ok: false, error: 'upto_settle_exceeds_max', detail: `Settle amount ${settleAmount} is negative.` }
  }
  if (settleAmount > permittedAmount) {
    return { ok: false, error: 'upto_settle_exceeds_max', detail: `Settle amount ${settleAmount} exceeds the signed MAX ${permittedAmount}.` }
  }
  const now = BigInt(Math.floor(Date.now() / 1000))
  if (deadline <= now) {
    return { ok: false, error: 'payment_expired', detail: `Permit2 deadline ${deadline} <= now ${now}.` }
  }
  // NB: we do NOT pre-check `validAfter` off-chain — the proxy enforces it (`block.timestamp
  // >= validAfter`) at settle time, and the simulateContract below runs that authoritatively.

  // Smart-wallet payers (EIP-1271 / EIP-7702) have CODE at `from`: Permit2 validates their
  // signature ON-CHAIN, so we recover off-chain ONLY for a bare EOA and defer a contract
  // `from` to the simulate below (every trusted-accept field check already ran).
  let fromCode: string | undefined
  try {
    fromCode = await publicClient.getCode({ address: from })
  } catch {
    return { ok: false, error: 'tx_not_found', detail: `Could not read code at ${from} (transient RPC) — retry.` }
  }
  if (!(fromCode && fromCode !== '0x')) {
    let recovered: `0x${string}`
    try {
      // Recover against permitted.amount (the signed MAX) + the FULL upto witness (incl.
      // facilitator) — the buyer signed over the ceiling, NEVER the metered settleAmount.
      recovered = await recoverTypedDataAddress({
        domain: { name: 'Permit2', chainId: chain.id, verifyingContract: PERMIT2_ADDRESS },
        types: PERMIT2_UPTO_WITNESS_TYPES,
        primaryType: 'PermitWitnessTransferFrom',
        message: {
          permitted: { token: permittedToken, amount: permittedAmount },
          spender,
          nonce,
          deadline,
          witness: { to: witnessTo, facilitator: witnessFacilitator, validAfter },
        },
        signature: signature as `0x${string}`,
      })
    } catch (err) {
      return { ok: false, error: 'signature_invalid', detail: `Not a valid EIP-712 signature: ${shorten(err instanceof Error ? err.message : String(err))}.` }
    }
    if (recovered !== from) {
      return { ok: false, error: 'signature_invalid', detail: `Signature recovered to ${recovered}, not the authorizer ${from}.` }
    }
  }

  // --- ZERO-CHARGE short-circuit: a $0 settle has NO on-chain tx (the proxy reverts on amount==0,
  //     and the spec says an unused authorization simply expires). Return a synthetic receipt with
  //     transaction "" (empty STRING per spec §5.3, never omitted). The Permit2 nonce stays
  //     un-broadcast on-chain, but the GATE's replay set already burned it (claimed before metering),
  //     so it can't be re-presented. No RPC, no gas. ---
  if (settleAmount === 0n) {
    return {
      ok: true,
      receipt: {
        scheme: 'upto',
        success: true,
        network: accept.network,
        transaction: '',
        asset: accept.asset,
        amount: '0',
        payer: from,
        payTo: accept.payTo,
        verifiedAt: new Date().toISOString(),
      },
    }
  }

  // --- on-chain replay check (Permit2's unordered-nonce bitmap) ---
  try {
    const word = nonce >> 8n
    const bit = nonce & 0xffn
    const bitmap = (await publicClient.readContract({
      address: PERMIT2_ADDRESS,
      abi: permit2NonceBitmapAbi,
      functionName: 'nonceBitmap',
      args: [from, word],
    })) as bigint
    if (((bitmap >> bit) & 1n) === 1n) {
      return { ok: false, error: 'tx_already_used', detail: `Permit2 nonce ${nonce} already used or invalidated for ${from}.` }
    }
  } catch {
    return { ok: false, error: 'tx_not_found', detail: 'Could not read the Permit2 nonce bitmap (transient RPC) — retry.' }
  }

  // The settle args, rebuilt from the (validated) signed values + the metered ACTUAL at position 1.
  // The signature commits to permit/witness exactly; `settleAmount` is the merchant's chosen actual
  // (clamped ≤ the signed max above). owner = the payer (from).
  const settleArgs = [
    { permitted: { token: permittedToken, amount: permittedAmount }, nonce, deadline },
    settleAmount,
    from,
    { to: witnessTo, facilitator: witnessFacilitator, validAfter },
    signature as `0x${string}`,
  ] as const

  // --- simulate BEFORE spending gas (catches used nonce / missing approval / low balance / too-early) ---
  try {
    await publicClient.simulateContract({
      account,
      address: proxy,
      abi: x402UptoProxyAbi,
      functionName: 'settle',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      args: settleArgs as any,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/nonce|invalidated|used/i.test(msg)) return { ok: false, error: 'tx_already_used', detail: 'Permit2 nonce is used or invalidated.' }
    if (/expired|deadline|too early|not yet/i.test(msg)) return { ok: false, error: 'payment_expired', detail: shorten(msg) }
    if (/exceeds.*permitted|AmountExceeds/i.test(msg)) return { ok: false, error: 'upto_settle_exceeds_max', detail: shorten(msg) }
    if (/facilitator|Unauthorized/i.test(msg)) return { ok: false, error: 'signature_invalid', detail: shorten(msg) }
    if (/signature/i.test(msg)) return { ok: false, error: 'signature_invalid', detail: shorten(msg) }
    // Missing Permit2 approval, insufficient balance, paused/blacklisted → client-fixable.
    return { ok: false, error: 'tx_reverted', detail: `upto settle would revert: ${shorten(msg)}` }
  }

  // --- BROADCAST (settle the ACTUAL). Failure here is SERVER-side → throw SettlementError. ---
  let txHash: `0x${string}`
  try {
    txHash = await walletClient.writeContract({
      account,
      chain,
      address: proxy,
      abi: x402UptoProxyAbi,
      functionName: 'settle',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      args: settleArgs as any,
    })
  } catch (err) {
    throw new SettlementError(
      `upto settle: the merchant relayer failed to broadcast the proxy settle ` +
        `(${shorten(err instanceof Error ? err.message : String(err))}). The payer's signature ` +
        `is still valid and its nonce unused — fund/fix the relayer and the payer can retry.`,
      { cause: err }
    )
  }
  try {
    const confirmations = accept.extra.minConfirmations ?? 1
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, confirmations })
    if (receipt.status !== 'success') {
      return { ok: false, error: 'tx_reverted', detail: `Settlement tx ${txHash} reverted on-chain.` }
    }
  } catch (err) {
    throw new SettlementError(
      `upto settle: broadcast ${txHash} but couldn't confirm it (${shorten(err instanceof Error ? err.message : String(err))}).`,
      { cause: err }
    )
  }

  return {
    ok: true,
    receipt: {
      scheme: 'upto',
      success: true,
      network: accept.network,
      transaction: txHash,
      asset: accept.asset,
      // The ACTUAL settled amount (≤ max) — what the buyer reads back to record metered spend.
      amount: settleAmount.toString(),
      payer: from,
      payTo: accept.payTo,
      verifiedAt: new Date().toISOString(),
    },
  }
}
