/**
 * ── ALGORAND SECTION: wallet ──
 * Validate + wrap the agent's wallet config (mirrors the other families).
 * Accepts `{ key }` (a 25-word Algorand recovery phrase) or a ready
 * `{ account }` (an algosdk `{ addr, sk }`). Rejects pre-v2 wallet shapes with a
 * clear WrongFamilyError.
 *
 * The `chain: 'algorand'` selector routes here and the phrase is validated by
 * `mnemonicToSecretKey` — a 24-word TON mnemonic is the wrong length and surfaces
 * a clear error.
 */
import algosdk from 'algosdk'
import { WrongFamilyError } from '../../errors.js'
import { assertNoLegacyWalletKey } from '../wallet-migrate.js'

/** A resolved Algorand signer — the 58-char address + the 64-byte secret key. */
export interface AlgorandSigner {
  addr: string
  sk: Uint8Array
}

export interface AlgorandWalletConfig {
  /** A 25-word Algorand mnemonic (the account's recovery phrase). */
  key?: string
  /** A ready algosdk account `{ addr, sk }`, if you built it yourself. */
  account?: { addr: unknown; sk: Uint8Array }
}

/** Sync shape-check (mirrors the other families' wrong-family guard). */
export function assertAlgorandWallet(
  wallet: unknown,
  network: string
): AlgorandWalletConfig {
  if (typeof wallet !== 'object' || wallet === null) {
    throw new WrongFamilyError(
      `chain ${network} is Algorand; wallet must be { key } (25-word mnemonic) or { account }.`
    )
  }
  assertNoLegacyWalletKey(wallet, 'Algorand')
  if (!('key' in wallet) && !('account' in wallet)) {
    throw new WrongFamilyError(
      `chain ${network} is Algorand; wallet must be { key } (25-word mnemonic) or { account }.`
    )
  }
  return wallet as AlgorandWalletConfig
}

/** Build the signing account from the validated config. */
export function resolveAlgorandWallet(config: AlgorandWalletConfig): AlgorandSigner {
  if (config.account) {
    return { addr: String(config.account.addr), sk: config.account.sk }
  }
  if (config.key != null) {
    try {
      const { addr, sk } = algosdk.mnemonicToSecretKey(config.key)
      return { addr: addr.toString(), sk }
    } catch (cause) {
      throw new WrongFamilyError(
        'Algorand wallet { key } is not a valid 25-word Algorand mnemonic.',
        { cause }
      )
    }
  }
  throw new WrongFamilyError('Algorand wallet needs { key } (25-word mnemonic) or { account }.')
}
