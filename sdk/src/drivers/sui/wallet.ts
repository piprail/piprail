/**
 * ── SUI SECTION: wallet ──
 * Validate + wrap the agent's wallet config (mirrors the other families).
 * Accepts `{ key }` (a `suiprivkey1…` bech32 secret, or a raw 32-byte
 * Uint8Array) or a ready `{ keypair }` (an Ed25519Keypair). Rejects pre-v2
 * wallet shapes with a clear WrongFamilyError.
 *
 * The `chain: 'sui'` selector routes here and the bech32/byte format is
 * validated by Ed25519Keypair — a hex `0x…` EVM key won't parse and surfaces a
 * clear error.
 */
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519'
import { WrongFamilyError } from '../../errors.js'
import { assertNoLegacyWalletKey } from '../wallet-migrate.js'

export interface SuiWalletConfig {
  /** A `suiprivkey1…` bech32 secret, or the raw 32-byte secret. */
  key?: string | Uint8Array
  /** A ready @mysten/sui Ed25519Keypair, if you built it yourself. */
  keypair?: Ed25519Keypair
}

/** Sync shape-check (mirrors the other families' wrong-family guard). */
export function assertSuiWallet(wallet: unknown, network: string): SuiWalletConfig {
  if (typeof wallet !== 'object' || wallet === null) {
    throw new WrongFamilyError(
      `chain ${network} is Sui; wallet must be { key } (suiprivkey1… ) or { keypair }.`
    )
  }
  assertNoLegacyWalletKey(wallet, 'Sui')
  if (!('key' in wallet) && !('keypair' in wallet)) {
    throw new WrongFamilyError(
      `chain ${network} is Sui; wallet must be { key } (suiprivkey1…) or { keypair }.`
    )
  }
  return wallet as SuiWalletConfig
}

/** Build the signing Ed25519Keypair from the validated config. */
export function resolveSuiKeypair(config: SuiWalletConfig): Ed25519Keypair {
  if (config.keypair) return config.keypair
  if (config.key != null) {
    try {
      return Ed25519Keypair.fromSecretKey(config.key)
    } catch (cause) {
      throw new WrongFamilyError(
        'Sui wallet { key } is not a valid suiprivkey1… secret (or 32-byte key).',
        { cause }
      )
    }
  }
  throw new WrongFamilyError('Sui wallet needs { key } (suiprivkey1…) or { keypair }.')
}
