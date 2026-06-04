/**
 * ── APTOS SECTION: wallet ──
 * Validate + wrap the agent's wallet config (mirrors the other families).
 * Accepts `{ privateKey }` (an AIP-80 `ed25519-priv-0x…` secret, or a raw `0x…`
 * hex key) or a ready `{ account }` (an Aptos `Account`). Rejects EVM / Solana /
 * TON / Stellar / XRPL / Sui / NEAR wallet shapes with a clear WrongFamilyError.
 *
 * `privateKey` is shared with EVM/Tron/Sui by name, but the `chain: 'aptos'`
 * selector routes here and the format is validated by `Ed25519PrivateKey` — a hex
 * `0x…` EVM key is the wrong length and surfaces a clear error.
 */
import { Account, Ed25519PrivateKey } from '@aptos-labs/ts-sdk'
import { WrongFamilyError } from '../../errors.js'

export interface AptosWalletConfig {
  /** An AIP-80 `ed25519-priv-0x…` secret, or a raw `0x…` 32-byte hex key. */
  privateKey?: string
  /** A ready @aptos-labs/ts-sdk Account, if you built it yourself. */
  account?: Account
}

/** Sync shape-check (mirrors the other families' wrong-family guard). */
export function assertAptosWallet(wallet: unknown, network: string): AptosWalletConfig {
  if (typeof wallet !== 'object' || wallet === null) {
    throw new WrongFamilyError(
      `chain ${network} is Aptos; wallet must be { privateKey } (ed25519-priv-0x…) or { account }.`
    )
  }
  if ('walletClient' in wallet) {
    throw new WrongFamilyError(
      `chain ${network} is Aptos; a viem { walletClient } can't be used — pass { privateKey } (ed25519-priv-0x…) or { account }.`
    )
  }
  if (
    'secretKey' in wallet ||
    'signer' in wallet ||
    'mnemonic' in wallet ||
    'keypair' in wallet ||
    'keyPair' in wallet ||
    'secret' in wallet ||
    'seed' in wallet ||
    'accountId' in wallet
  ) {
    throw new WrongFamilyError(
      `chain ${network} is Aptos; that looks like another family's wallet — pass { privateKey } (ed25519-priv-0x…) or { account }.`
    )
  }
  if (!('privateKey' in wallet) && !('account' in wallet)) {
    throw new WrongFamilyError(
      `chain ${network} is Aptos; wallet must be { privateKey } (ed25519-priv-0x…) or { account }.`
    )
  }
  return wallet as AptosWalletConfig
}

/** Build the signing Account from the validated config. */
export function resolveAptosAccount(config: AptosWalletConfig): Account {
  if (config.account) return config.account
  if (config.privateKey != null) {
    try {
      return Account.fromPrivateKey({ privateKey: new Ed25519PrivateKey(config.privateKey) })
    } catch (cause) {
      throw new WrongFamilyError(
        'Aptos wallet { privateKey } is not a valid ed25519 secret (ed25519-priv-0x… or 0x… hex).',
        { cause }
      )
    }
  }
  throw new WrongFamilyError('Aptos wallet needs { privateKey } (ed25519-priv-0x…) or { account }.')
}
