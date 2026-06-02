/**
 * ── TON SECTION: wallet ──
 * Validate + wrap the agent's wallet config (mirrors evm/solana wallet.ts).
 * Accepts `{ mnemonic }` (24 words — a string[] or one space-separated string)
 * or a ready `{ keyPair }`; rejects EVM/Solana wallet shapes with a clear
 * `WrongFamilyError`.
 *
 * The wallet *shape* is checked synchronously (so wrong-family mistakes surface
 * at bind time, like the other drivers). The actual key derivation is async
 * (mnemonic → key uses PBKDF2), so it's deferred to `resolveTonWallet`, called
 * from the driver's async `send()`.
 */
import { mnemonicToWalletKey, type KeyPair } from '@ton/crypto'
import { WalletContractV4, WalletContractV5R1 } from '@ton/ton'
import { WrongFamilyError } from '../../errors.js'

/** Wallet contract version. `v4` is the classic default; `v5r1` is W5. */
export type TonWalletVersion = 'v4' | 'v5r1'

export interface TonWalletConfig {
  /** 24-word TON mnemonic — a string[] or a single space-separated string. */
  mnemonic?: string | string[]
  /** A ready @ton/crypto KeyPair, if you derived the key yourself. */
  keyPair?: KeyPair
  /** Wallet contract version. Default `v4`. Use `v5r1` for a W5 wallet. */
  version?: TonWalletVersion
}

export interface TonWallet {
  keyPair: KeyPair
  contract: WalletContractV4 | WalletContractV5R1
}

/** Sync shape-check (mirrors the other families' wrong-family guard). */
export function assertTonWallet(wallet: unknown, network: string): TonWalletConfig {
  if (typeof wallet !== 'object' || wallet === null) {
    throw new WrongFamilyError(
      `chain ${network} is TON; wallet must be { mnemonic } (24 words) or { keyPair }.`
    )
  }
  if ('privateKey' in wallet || 'walletClient' in wallet) {
    throw new WrongFamilyError(
      `chain ${network} is TON; an EVM wallet can't be used — pass { mnemonic } (24 words) or { keyPair }.`
    )
  }
  if (!('mnemonic' in wallet) && !('keyPair' in wallet)) {
    throw new WrongFamilyError(
      `chain ${network} is TON; wallet must be { mnemonic } (24 words) or { keyPair }.`
    )
  }
  return wallet as TonWalletConfig
}

/** Async: derive the keypair (mnemonic → key) and open the wallet contract. */
export async function resolveTonWallet(config: TonWalletConfig): Promise<TonWallet> {
  const version: TonWalletVersion = config.version ?? 'v4'

  let keyPair: KeyPair
  if (config.mnemonic) {
    const words = Array.isArray(config.mnemonic)
      ? config.mnemonic
      : config.mnemonic.trim().split(/\s+/)
    keyPair = await mnemonicToWalletKey(words)
  } else if (config.keyPair) {
    keyPair = config.keyPair
  } else {
    throw new WrongFamilyError('TON wallet needs { mnemonic } (24 words) or { keyPair }.')
  }

  const contract =
    version === 'v5r1'
      ? WalletContractV5R1.create({ workchain: 0, publicKey: keyPair.publicKey })
      : WalletContractV4.create({ workchain: 0, publicKey: keyPair.publicKey })

  return { keyPair, contract }
}
