/**
 * Merchant presets — named, batteries-included sugar over {@link createPaymentGate}.
 *
 * Same wire, same gate, less to think about: a merchant says WHAT they're selling (a paywall, a
 * tip jar) instead of wiring a gate by hand. Each preset resolves to a standard
 * `createPaymentGate(...)`, so the 402 it builds is **byte-identical** to the equivalent
 * hand-written gate (asserted in `test/merchant.test.ts` against `describe()`). Pure +
 * browser-safe: this module imports only the chain-agnostic gate + its types (no viem, no `node:`).
 *
 *   import { createPaywall } from '@piprail/sdk'
 *   const gate = createPaywall({ chain: 'base', amount: '0.05', payTo: '0xYourWallet' })
 *   // token defaults to USDC — every other createPaymentGate option still works (onPaid, exact, …).
 */
import { createPaymentGate } from './server.js'
import type { RequirePaymentOptions, PaymentGate } from './server.js'
import type { ChainSelector, TokenInput } from './drivers/types.js'
import type { AddressId } from './x402.js'

/**
 * The advanced gate options a preset forwards verbatim — every {@link RequirePaymentOptions} field
 * EXCEPT the `chain`/`token`/`amount`/`payTo` quartet (each preset re-declares those with its own
 * shape) and the multi-chain `accept` array (use {@link createPaymentGate} directly for a multi-rail
 * gate). So `onPaid`, `exact`, `receipts`, `discovery`, `isUsed`/`markUsed`, … all pass through.
 */
type GateExtras = Omit<RequirePaymentOptions, 'chain' | 'token' | 'amount' | 'payTo' | 'accept'>

/** Options for {@link createPaywall}. */
export interface PaywallOptions extends GateExtras {
  /** Which chain to be paid on. EVM (`'base'`|`'bnb'`|…) or a non-EVM family name. */
  chain: ChainSelector
  /** Token to charge in. Defaults to **USDC**. */
  token?: TokenInput
  /** The fixed price, human-readable, e.g. `'0.05'`. */
  amount: string
  /** Your receiving wallet address — no private key (receiving needs only the address). */
  payTo: AddressId
}

/**
 * Gate one resource behind a fixed price — the API / SaaS / premium-content case. Sugar over
 * {@link createPaymentGate} with `token` defaulting to USDC; every other gate option is forwarded
 * unchanged, so the resulting gate (and its 402) is identical to the hand-written equivalent.
 */
export function createPaywall({ token = 'USDC', ...rest }: PaywallOptions): PaymentGate {
  return createPaymentGate({ token, ...rest })
}

/** Options for {@link createTipJar}. */
export interface TipJarOptions extends GateExtras {
  /** Which chain to be paid on. */
  chain: ChainSelector
  /** Token to accept. Defaults to **USDC**. */
  token?: TokenInput
  /**
   * The MINIMUM tip, human-readable, e.g. `'1.00'`. The gate accepts any payment **≥ min** — the
   * on-chain verify rejects only an under-payment (`amount_too_low`), so a payer can always give
   * more. There is no upper bound; the minimum is a floor, not a fixed price.
   */
  min: string
  /** Your receiving wallet address. */
  payTo: AddressId
}

/**
 * An open "pay what you want (≥ a minimum)" gate — the creator / tip / donation case. Sugar over
 * {@link createPaymentGate} that sets the challenge `amount` to `min`; because the gate accepts an
 * over-payment, the minimum is a floor. Everything else (`onPaid`, etc.) forwards unchanged.
 */
export function createTipJar({ token = 'USDC', min, ...rest }: TipJarOptions): PaymentGate {
  return createPaymentGate({ token, amount: min, ...rest })
}
