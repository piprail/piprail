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
    /*
     * Match the family name EXACTLY, or as the namespace of a CAIP-2 id ('solana:5eykt…').
     *
     * This was a bare `startsWith`, which is a trap that springs the moment an EVM preset's
     * name begins with a family name. It did: `chain: 'xrplevm'` (the XRPL EVM Sidechain, an
     * ordinary EVM chain) routed to the XRP LEDGER driver, which then failed to recognise its
     * own input. The failure surfaced as "the xrpl driver didn't recognise this chain input",
     * which points at the driver rather than at the routing that misdelivered it.
     */
    const ns = chain.includes(':') ? chain.slice(0, chain.indexOf(':')) : chain
    const NON_EVM: readonly ChainFamily[] = [
      'solana', 'ton', 'stellar', 'xrpl', 'tron', 'sui', 'near', 'aptos', 'algorand',
    ]
    const hit = NON_EVM.find((f) => ns === f)
    return hit ?? 'evm'
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
