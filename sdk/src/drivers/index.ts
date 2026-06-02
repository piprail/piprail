/**
 * Driver wiring + auto-mount.
 *
 * EVM is registered eagerly (viem is a hard peer dep, always present). Other
 * families load THEMSELVES the first time you name that chain — there is no
 * `enableSolana()` step. Naming `chain: 'solana'` just works, exactly like
 * `chain: 'base'`:
 *
 *   requirePayment({ chain: 'solana', amount: '0.05', payTo })   // mounts on first use
 *
 * The mount is one dynamic `import()`, so a pure-EVM consumer never pulls in
 * `@solana/web3.js` — it only loads when a Solana chain is actually used.
 */
import {
  registerDriver,
  resolveNetwork as resolveSync,
  familyForChain,
  isRegistered,
} from './registry.js'
import { evmDriver } from './evm/index.js'
import { MissingDriverError } from '../errors.js'
import type { ChainFamily, ResolveOptions, ResolvedNetwork } from './types.js'

// ── EVM is always available ──
registerDriver(evmDriver)

/**
 * Lazy loaders for families whose dependencies are optional. Each does one
 * dynamic import (a code-split chunk) and registers its driver. Add a family
 * (e.g. TON) by adding one entry here + its `drivers/<family>/` folder.
 */
const loaders: Partial<Record<ChainFamily, () => Promise<void>>> = {
  solana: async () => {
    let mod: typeof import('./solana/index.js')
    try {
      mod = await import('./solana/index.js')
    } catch (cause) {
      throw new MissingDriverError(
        `Solana selected, but its packages aren't installed. Run: ` +
          `npm install @solana/web3.js @solana/spl-token bs58`,
        { cause }
      )
    }
    registerDriver(mod.solanaDriver)
  },
  ton: async () => {
    let mod: typeof import('./ton/index.js')
    try {
      mod = await import('./ton/index.js')
    } catch (cause) {
      throw new MissingDriverError(
        `TON selected, but its packages aren't installed. Run: ` +
          `npm install @ton/ton @ton/core @ton/crypto`,
        { cause }
      )
    }
    registerDriver(mod.tonDriver)
  },
  stellar: async () => {
    let mod: typeof import('./stellar/index.js')
    try {
      mod = await import('./stellar/index.js')
    } catch (cause) {
      throw new MissingDriverError(
        `Stellar selected, but its package isn't installed. Run: ` +
          `npm install @stellar/stellar-sdk`,
        { cause }
      )
    }
    registerDriver(mod.stellarDriver)
  },
  xrpl: async () => {
    let mod: typeof import('./xrpl/index.js')
    try {
      mod = await import('./xrpl/index.js')
    } catch (cause) {
      throw new MissingDriverError(
        `XRPL selected, but its package isn't installed. Run: ` + `npm install xrpl`,
        { cause }
      )
    }
    registerDriver(mod.xrplDriver)
  },
  tron: async () => {
    let mod: typeof import('./tron/index.js')
    try {
      mod = await import('./tron/index.js')
    } catch (cause) {
      throw new MissingDriverError(
        `Tron selected, but its package isn't installed. Run: ` + `npm install tronweb`,
        { cause }
      )
    }
    registerDriver(mod.tronDriver)
  },
  sui: async () => {
    let mod: typeof import('./sui/index.js')
    try {
      mod = await import('./sui/index.js')
    } catch (cause) {
      throw new MissingDriverError(
        `Sui selected, but its package isn't installed. Run: ` + `npm install @mysten/sui`,
        { cause }
      )
    }
    registerDriver(mod.suiDriver)
  },
  near: async () => {
    let mod: typeof import('./near/index.js')
    try {
      mod = await import('./near/index.js')
    } catch (cause) {
      throw new MissingDriverError(
        `NEAR selected, but its package isn't installed. Run: ` + `npm install near-api-js`,
        { cause }
      )
    }
    registerDriver(mod.nearDriver)
  },
}

const inFlight = new Map<ChainFamily, Promise<void>>()

/**
 * Ensure the driver for `family` is registered, auto-importing it on first
 * use. Concurrent callers share one in-flight import; a failed import is not
 * cached, so a later call can retry.
 */
export async function ensureDriver(family: ChainFamily): Promise<void> {
  if (isRegistered(family)) return
  const load = loaders[family]
  if (!load) return // no loader → resolveSync throws UnsupportedNetworkError (defensive)
  let pending = inFlight.get(family)
  if (!pending) {
    pending = load()
    inFlight.set(family, pending)
  }
  try {
    await pending
  } catch (err) {
    inFlight.delete(family)
    throw err
  }
}

/**
 * Resolve a `chain` selector to a bound network, auto-mounting its family
 * driver if needed. This is the async entry the gate and client use.
 */
export async function resolveNetwork(
  opts: ResolveOptions
): Promise<ResolvedNetwork> {
  await ensureDriver(familyForChain(opts.chain))
  return resolveSync(opts)
}

export { registerDriver, familyForChain }
