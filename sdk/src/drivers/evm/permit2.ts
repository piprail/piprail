/**
 * ── EVM SECTION: x402 `exact` scheme, `permit2` variant — BUYER + SELLER ──────
 *
 * The companion to `exact.ts` for ERC-20 tokens that do NOT implement EIP-3009
 * `transferWithAuthorization` — most notably **Binance-Peg USDC/USDT on BNB Chain**
 * (no native Circle USDC exists on BNB). The x402 `exact` EVM scheme defines a second
 * `assetTransferMethod`, `"permit2"`, for exactly these tokens:
 *
 *   • The payer signs an EIP-712 **`PermitWitnessTransferFrom`** over the canonical
 *     **Permit2** contract, with `spender` = the canonical **x402ExactPermit2Proxy**
 *     and a **witness** that binds the recipient (`to`) + an activation time
 *     (`validAfter`). The buyer never broadcasts (and, after a one-time Permit2 approval,
 *     spends ~0 gas) — the merchant/facilitator broadcasts.
 *   • The merchant/facilitator settles by calling the **proxy's `settle(...)`**, which
 *     calls `Permit2.permitWitnessTransferFrom`. Because the signed `spender` is the
 *     proxy and the proxy forces `transferDetails.to == witness.to`, a relayer can only
 *     push the signed funds to the signed recipient — no redirect risk (same guarantee
 *     EIP-3009's `to`-binding gives us).
 *
 * Spec: github.com/coinbase/x402 `specs/schemes/exact/scheme_exact_evm.md` (the Permit2
 * method). Both contracts are canonical CREATE2 deployments (same address every EVM
 * chain) and are verified deployed on BNB. This module mirrors `exact.ts` file-for-file
 * (buyer {@link payPermit2Evm}; seller {@link verifyAndSettlePermit2Evm}); the EVM
 * driver routes to it on `accept.extra.assetTransferMethod === 'permit2'`.
 *
 * One-time setup: the payer must `approve(Permit2, max)` on the token ONCE
 * ({@link ensurePermit2Allowance} does this lazily) — after that, every payment is a
 * gasless signature. This is the only way `permit2` differs operationally from EIP-3009.
 */
import {
  erc20Abi,
  getAddress,
  maxUint256,
  recoverTypedDataAddress,
  type Account,
  type Chain,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem'
import {
  InsufficientFundsError,
  SettlementError,
  UnsupportedSchemeError,
  toInsufficientFundsError,
} from '../../errors.js'
import type {
  Permit2Authorization,
  Permit2PaymentPayload,
  VerifyResult,
  X402ExactAcceptEntry,
} from '../../x402.js'

/** Canonical Permit2 (Uniswap), same address on every EVM chain incl. BNB. */
export const PERMIT2_ADDRESS = '0x000000000022D473030F116dDEE9F6B43aC78BA3' as const

/** Canonical x402ExactPermit2Proxy — the SAME CREATE2 address on every chain where it's been
 *  deployed (see {@link PERMIT2_PROXY_CHAIN_IDS}; it is NOT on every EVM chain). It is the
 *  `spender` the buyer signs over, and the contract the seller settles through; it enforces
 *  `transferDetails.to == witness.to`, so funds can only reach the signed payTo. */
export const X402_EXACT_PERMIT2_PROXY = '0x402085c248EeA27D92E8b30b2C58ed07f9E20001' as const

/** EVM chain ids where BOTH the canonical Permit2 AND the x402ExactPermit2Proxy are deployed —
 *  i.e. where the **Permit2** transfer method of `exact` can actually settle. Verified on-chain
 *  (`eth_getCode`, 2026-06-11). EIP-3009 needs NO proxy, so this gates only the Permit2 fallback;
 *  on a non-EIP-3009 token on a chain absent here, the gate offers `onchain-proof` only rather
 *  than an unsettleable Permit2 rail. The proxy is a permissionless CREATE2 deploy, so extend
 *  this as it lands on more chains (re-verify before adding). */
export const PERMIT2_PROXY_CHAIN_IDS: ReadonlySet<number> = new Set([
  1, // Ethereum
  8453, // Base
  42161, // Arbitrum
  10, // Optimism
  137, // Polygon
  43114, // Avalanche
  56, // BNB
  42220, // Celo
  480, // World Chain
  1329, // Sei
  999, // HyperEVM
  143, // Monad
])

/** Whether a chain has the x402 Permit2 proxy deployed (→ can settle the Permit2 exact method). */
export function isPermit2ProxyChain(chainId: number): boolean {
  return PERMIT2_PROXY_CHAIN_IDS.has(chainId)
}

/**
 * EIP-712 type set for the x402 `permit2` exact method. MUST encode to exactly the type
 * string Permit2 reconstructs for `permitWitnessTransferFrom`:
 *   `PermitWitnessTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline,Witness witness)TokenPermissions(address token,uint256 amount)Witness(address to,uint256 validAfter)`
 * (viem orders referenced structs alphabetically → TokenPermissions before Witness ✓.)
 */
export const PERMIT2_WITNESS_TYPES = {
  PermitWitnessTransferFrom: [
    { name: 'permitted', type: 'TokenPermissions' },
    { name: 'spender', type: 'address' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
    { name: 'witness', type: 'Witness' },
  ],
  TokenPermissions: [
    { name: 'token', type: 'address' },
    { name: 'amount', type: 'uint256' },
  ],
  Witness: [
    { name: 'to', type: 'address' },
    { name: 'validAfter', type: 'uint256' },
  ],
} as const

/** The proxy's `settle(permit, owner, witness, signature)` — what the seller broadcasts. */
export const x402Permit2ProxyAbi = [
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
      { name: 'owner', type: 'address' },
      {
        name: 'witness',
        type: 'tuple',
        components: [
          { name: 'to', type: 'address' },
          { name: 'validAfter', type: 'uint256' },
        ],
      },
      { name: 'signature', type: 'bytes' },
    ],
  },
] as const

/** Permit2's unordered-nonce bitmap, for the seller's off-chain replay pre-check. */
export const permit2NonceBitmapAbi = [
  {
    type: 'function',
    name: 'nonceBitmap',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'word', type: 'uint256' },
    ],
    outputs: [{ type: 'uint256' }],
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
      'this runtime lacks Web Crypto (globalThis.crypto.getRandomValues); the permit2 rail needs a CSPRNG nonce.'
    )
  }
  const raw = new Uint8Array(32)
  g.getRandomValues(raw)
  return BigInt(`0x${[...raw].map((b) => b.toString(16).padStart(2, '0')).join('')}`)
}

/**
 * Ensure `owner` has approved Permit2 to move at least `amount` of `token`. ERC-20
 * `approve` is all-or-nothing per spender, so we approve `maxUint256` ONCE and never
 * again. Returns the approval tx hash when one was sent, else `undefined` (already
 * approved). The ONLY on-chain action the buyer takes — and only the first time.
 */
export async function ensurePermit2Allowance(input: {
  publicClient: PublicClient
  walletClient: WalletClient
  account: Account
  chain: Chain
  token: `0x${string}`
  amount: bigint
}): Promise<`0x${string}` | undefined> {
  const { publicClient, walletClient, account, chain, token, amount } = input
  let allowance: bigint
  try {
    allowance = (await publicClient.readContract({
      address: token,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [account.address, PERMIT2_ADDRESS],
    })) as bigint
  } catch (err) {
    throw new UnsupportedSchemeError(
      `permit2: couldn't read the Permit2 allowance for ${token} (${shorten(err instanceof Error ? err.message : String(err))}).`
    )
  }
  if (allowance >= amount) return undefined
  try {
    const hash = await walletClient.writeContract({
      account,
      chain,
      address: token,
      abi: erc20Abi,
      functionName: 'approve',
      args: [PERMIT2_ADDRESS, maxUint256],
    })
    await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 })
    return hash
  } catch (err) {
    // A failed approve is almost always "not enough native coin for gas" — map it to
    // the affordability error so an agent tops up its gas, not chases a phantom bug.
    throw (
      toInsufficientFundsError(err) ??
      new SettlementError(
        `permit2: the one-time Permit2 approval for ${token} failed to broadcast ` +
          `(${shorten(err instanceof Error ? err.message : String(err))}).`,
        { cause: err }
      )
    )
  }
}

/**
 * BUYER, production path — sign an x402 `permit2` exact payment for a standard rail whose
 * token lacks EIP-3009 (e.g. Binance-Peg USDC on BNB). Lazily ensures the one-time Permit2
 * approval, then EIP-712-signs a `PermitWitnessTransferFrom` (spender = the x402 proxy,
 * witness.to = the rail's payTo). Returns the wire payload the client frames into
 * `PAYMENT-SIGNATURE`; the merchant/facilitator broadcasts the proxy `settle`.
 *
 * Re-derives nothing sensitive: `spender` is OUR constant proxy and the EIP-712 domain is
 * Permit2's own — only `token`/`amount`/`payTo` come from the (server-supplied) accept, and
 * those are exactly what the signature commits to, so a lying server can only mis-price its
 * OWN rail (the client's spend budget still guards the amount). EOA-only: refuses a contract
 * / EIP-1271 / EIP-7702 signer BEFORE signing.
 */
export async function payPermit2Evm(input: {
  publicClient: PublicClient
  walletClient: WalletClient
  account: Account
  chainId: number
  chain: Chain
  accept: X402ExactAcceptEntry
}): Promise<{ payload: Permit2PaymentPayload; payerFrom: string; nonce: string; approvalTx?: string }> {
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
      `permit2 buyer rail requires an EOA signer; ${account.address} is a contract / ` +
        `EIP-1271 / EIP-7702-delegated account. Pay via onchain-proof.`
    )
  }

  const token = getAddress(accept.asset)
  const payTo = getAddress(accept.payTo)
  const value = BigInt(accept.amount) // base units, already scaled by decimals

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
  const spender = getAddress(X402_EXACT_PERMIT2_PROXY)
  const from = account.address

  // Sign via the WALLET CLIENT (a bring-your-own JsonRpcAccount's account.signTypedData is undefined).
  const signature = await walletClient.signTypedData({
    account,
    domain: { name: 'Permit2', chainId, verifyingContract: PERMIT2_ADDRESS },
    types: PERMIT2_WITNESS_TYPES,
    primaryType: 'PermitWitnessTransferFrom',
    message: {
      permitted: { token, amount: value },
      spender,
      nonce,
      deadline,
      witness: { to: payTo, validAfter },
    },
  })

  const permit2Authorization: Permit2Authorization = {
    permitted: { token, amount: value.toString() },
    from,
    spender,
    nonce: nonce.toString(),
    deadline: deadline.toString(),
    witness: { to: payTo, validAfter: validAfter.toString() },
  }
  return {
    payload: { signature, permit2Authorization },
    payerFrom: from,
    nonce: nonce.toString(),
    ...(approvalTx ? { approvalTx } : {}),
  }
}

/**
 * SELLER — verify an inbound x402 `permit2` exact payment locally, then SELF-SETTLE it by
 * broadcasting the proxy's `settle(...)` from the merchant's `relayer`. The trusted `accept`
 * (the gate's own rail) is the source of truth for payTo / amount / asset; the client's
 * `permit2Authorization` is matched + recovered against it, never trusted. Mirrors
 * `verifyAndSettleExactEvm`'s contract: `{ ok:false, error }` for a CLIENT-fixable fault
 * (→ 402), `{ ok:true, receipt }` once mined, and THROWS {@link SettlementError} for a
 * SERVER-side broadcast failure (→ 5xx; the signature stays valid + its nonce unused).
 */
export async function verifyAndSettlePermit2Evm(input: {
  publicClient: PublicClient
  walletClient: WalletClient
  account: Account
  chain: Chain
  payload: Permit2PaymentPayload
  accept: X402ExactAcceptEntry
}): Promise<VerifyResult> {
  const { publicClient, walletClient, account, chain, payload, accept } = input
  const token = getAddress(accept.asset)
  const payTo = getAddress(accept.payTo)
  const requiredAmount = BigInt(accept.amount)
  const proxy = getAddress(X402_EXACT_PERMIT2_PROXY)

  // --- normalise the client-supplied authorization (validated, not trusted) ---
  let from: `0x${string}`
  let spender: `0x${string}`
  let permittedToken: `0x${string}`
  let witnessTo: `0x${string}`
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
    permittedAmount = BigInt(pa.permitted.amount)
    nonce = BigInt(pa.nonce)
    deadline = BigInt(pa.deadline)
    validAfter = BigInt(pa.witness.validAfter)
    if (!/^0x[0-9a-fA-F]+$/.test(signature)) throw new Error('signature must be hex')
  } catch (err) {
    return {
      ok: false,
      error: 'signature_invalid',
      detail: `Malformed permit2 authorization: ${err instanceof Error ? err.message : String(err)}.`,
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
    return { ok: false, error: 'signature_invalid', detail: `Authorization spender ${spender} is not the x402ExactPermit2Proxy ${proxy}; it can't be settled here.` }
  }
  if (permittedAmount < requiredAmount) {
    return { ok: false, error: 'amount_too_low', detail: `Permitted ${permittedAmount}, required ${requiredAmount}.` }
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
      recovered = await recoverTypedDataAddress({
        domain: { name: 'Permit2', chainId: chain.id, verifyingContract: PERMIT2_ADDRESS },
        types: PERMIT2_WITNESS_TYPES,
        primaryType: 'PermitWitnessTransferFrom',
        message: {
          permitted: { token: permittedToken, amount: permittedAmount },
          spender,
          nonce,
          deadline,
          witness: { to: witnessTo, validAfter },
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

  // The settle args, rebuilt from the (validated) signed values — the signature commits to
  // exactly these, so they can't be substituted, only checked (which we did above).
  const settleArgs = [
    { permitted: { token: permittedToken, amount: permittedAmount }, nonce, deadline },
    from,
    { to: witnessTo, validAfter },
    signature as `0x${string}`,
  ] as const

  // --- simulate BEFORE spending gas (catches used nonce / missing approval / low balance / too-early) ---
  try {
    await publicClient.simulateContract({
      account,
      address: proxy,
      abi: x402Permit2ProxyAbi,
      functionName: 'settle',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      args: settleArgs as any,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/nonce|invalidated|used/i.test(msg)) return { ok: false, error: 'tx_already_used', detail: 'Permit2 nonce is used or invalidated.' }
    if (/expired|deadline|too early|not yet/i.test(msg)) return { ok: false, error: 'payment_expired', detail: shorten(msg) }
    if (/signature/i.test(msg)) return { ok: false, error: 'signature_invalid', detail: shorten(msg) }
    // Missing Permit2 approval, insufficient balance, paused/blacklisted → client-fixable.
    return { ok: false, error: 'tx_reverted', detail: `permit2 settle would revert: ${shorten(msg)}` }
  }

  // --- BROADCAST (settle). Failure here is SERVER-side → throw SettlementError. ---
  let txHash: `0x${string}`
  try {
    txHash = await walletClient.writeContract({
      account,
      chain,
      address: proxy,
      abi: x402Permit2ProxyAbi,
      functionName: 'settle',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      args: settleArgs as any,
    })
  } catch (err) {
    throw new SettlementError(
      `permit2 settle: the merchant relayer failed to broadcast the proxy settle ` +
        `(${shorten(err instanceof Error ? err.message : String(err))}). The payer's signature ` +
        `is still valid and its nonce unused — fund/fix the relayer and the payer can retry.`,
      { cause: err }
    )
  }
  try {
    const confirmations = accept.extra?.minConfirmations ?? 1
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, confirmations })
    if (receipt.status !== 'success') {
      return { ok: false, error: 'tx_reverted', detail: `Settlement tx ${txHash} reverted on-chain.` }
    }
  } catch (err) {
    throw new SettlementError(
      `permit2 settle: broadcast ${txHash} but couldn't confirm it (${shorten(err instanceof Error ? err.message : String(err))}).`,
      { cause: err }
    )
  }

  return {
    ok: true,
    receipt: {
      scheme: 'exact',
      success: true,
      network: accept.network,
      transaction: txHash,
      asset: accept.asset,
      amount: accept.amount,
      payer: from,
      payTo: accept.payTo,
      verifiedAt: new Date().toISOString(),
    },
  }
}
