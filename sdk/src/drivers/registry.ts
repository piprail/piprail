/**
 * The driver registry — the ONLY place the families meet. Routing decides a
 * family from the `chain` value (synchronously), then asks that family's
 * driver to bind the network. Add a family = register a driver here.
 */
import type {
  ChainFamily,
  PaymentDriver,
  ResolvedNetwork,
  ResolveOptions,
} from './types.js'
import { UnsupportedNetworkError } from '../errors.js'

const byFamily = new Map<ChainFamily, PaymentDriver>()

export function registerDriver(driver: PaymentDriver): void {
  byFamily.set(driver.family, driver)
}

/** Is the driver for this family already registered? */
export function isRegistered(family: ChainFamily): boolean {
  return byFamily.has(family)
}

/** Which family does this `chain` value belong to? Pure + synchronous. */
export function familyForChain(chain: unknown): ChainFamily {
  if (typeof chain === 'string') {
    if (chain.startsWith('solana')) return 'solana'
    if (chain.startsWith('ton')) return 'ton'
    if (chain.startsWith('stellar')) return 'stellar'
    if (chain.startsWith('xrpl')) return 'xrpl'
    if (chain.startsWith('tron')) return 'tron'
    if (chain.startsWith('sui')) return 'sui'
    if (chain.startsWith('near')) return 'near'
    return 'evm'
  }
  return 'evm' // viem Chain, { id, rpcUrl }, or an EVM preset name
}

/** Bind a concrete network for `opts.chain`, dispatching to its family driver. */
export function resolveNetwork(opts: ResolveOptions): ResolvedNetwork {
  const family = familyForChain(opts.chain)
  const driver = byFamily.get(family)
  if (!driver) {
    // The async resolveNetwork() in drivers/index.ts auto-mounts the family
    // first, so this is a defensive guard for direct resolveSync() use before a
    // family is mounted. MISSING_DRIVER is reserved for "optional peer deps not
    // installed" (thrown by the loaders); an unmounted/unknown family is
    // UnsupportedNetwork.
    throw new UnsupportedNetworkError(
      `No driver registered for the "${family}" family — it may not be mounted yet ` +
        `(use the async resolveNetwork()).`
    )
  }
  const net = driver.resolve(opts)
  if (!net) {
    throw new UnsupportedNetworkError(
      `The ${family} driver didn't recognise this chain input.`
    )
  }
  return net
}
