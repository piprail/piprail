/**
 * ── APTOS SECTION: wallet ──
 * Validate + wrap the agent's wallet config (mirrors the other families).
 * Accepts `{ key }` (an AIP-80 `ed25519-priv-0x…` secret, or a raw `0x…`
 * hex key) or a ready `{ account }` (an Aptos `Account`). Rejects pre-v2
 * wallet shapes with a clear WrongFamilyError.
 *
 * The `chain: 'aptos'` selector routes here and the format is validated by
 * `Ed25519PrivateKey` — a hex `0x…` EVM key is the wrong length and surfaces a
 * clear error.
 */
import { Account, Ed25519PrivateKey } from '@aptos-labs/ts-sdk'
import { WrongFamilyError } from '../../errors.js'
import { assertNoLegacyWalletKey } from '../wallet-migrate.js'

export interface AptosWalletConfig {
  /** An AIP-80 `ed25519-priv-0x…` secret, or a raw `0x…` 32-byte hex key. */
  key?: string
  /** A ready @aptos-labs/ts-sdk Account, if you built it yourself. */
  account?: Account
}

/** Sync shape-check (mirrors the other families' wrong-family guard). */
export function assertAptosWallet(wallet: unknown, network: string): AptosWalletConfig {
  if (typeof wallet !== 'object' || wallet === null) {
    throw new WrongFamilyError(
      `chain ${network} is Aptos; wallet must be { key } (ed25519-priv-0x…) or { account }.`
    )
  }
  assertNoLegacyWalletKey(wallet, 'Aptos')
  if (!('key' in wallet) && !('account' in wallet)) {
    throw new WrongFamilyError(
      `chain ${network} is Aptos; wallet must be { key } (ed25519-priv-0x…) or { account }.`
    )
  }
  return wallet as AptosWalletConfig
}

/** Build the signing Account from the validated config. */
export function resolveAptosAccount(config: AptosWalletConfig): Account {
  if (config.account) return config.account
  if (config.key != null) {
    try {
      return Account.fromPrivateKey({ privateKey: new Ed25519PrivateKey(config.key) })
    } catch (cause) {
      throw new WrongFamilyError(
        'Aptos wallet { key } is not a valid ed25519 secret (ed25519-priv-0x… or 0x… hex).',
        { cause }
      )
    }
  }
  throw new WrongFamilyError('Aptos wallet needs { key } (ed25519-priv-0x…) or { account }.')
}
