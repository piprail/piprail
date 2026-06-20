// Shared environment for the parity sandbox: Base-mainnet constants, the (optional) test
// wallet, and read-only chain helpers. NO secret is ever printed; the wallet is read from
// the gitignored repo-root .secrets and is OPTIONAL — when absent, the live suites self-skip.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { createPublicClient, http, getAddress, formatUnits, formatEther } from 'viem'
import { base } from 'viem/chains'
import { mnemonicToAccount } from 'viem/accounts'

export const RPC = process.env.BASE_RPC ?? 'https://base-rpc.publicnode.com'
export const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'

const here = dirname(fileURLToPath(import.meta.url)) // .../x402-parity-sandbox/lib

// GUARD: this sandbox exists to test the PUBLISHED package. On a fresh clone with no local
// node_modules, Node would walk up and resolve the monorepo workspace symlink instead —
// silently testing the working tree. Fail loudly rather than lie about what was tested.
{
  const sdkPath = createRequire(import.meta.url).resolve('@piprail/sdk')
  if (!sdkPath.includes('/x402-parity-sandbox/node_modules/')) {
    throw new Error(
      `@piprail/sdk resolved OUTSIDE this sandbox:\n  ${sdkPath}\n` +
      `This harness MUST test the published npm package, not the workspace build. ` +
      `Run \`npm install\` in examples/basics/x402-parity-sandbox first.`
    )
  }
}
// .secrets lives at the repo root — four levels up from lib/ (lib → sandbox → basics → examples → repo).
const WALLET_PATH = process.env.PIPRAIL_WALLET ?? resolve(here, '../../../..', '.secrets/wallets/evm-wallet.json')

/**
 * Load the gitignored EVM test wallet, or `null` when it's absent (CI / a fresh clone).
 * Shape: { payer, merchant, key, mnemonic }. `payer` (acct0) holds USDC + pays gas; `merchant`
 * (acct1) is the payTo and the Tier-2 attestation signer.
 */
export function loadWallet() {
  try {
    const w = JSON.parse(readFileSync(WALLET_PATH, 'utf8'))
    if (!w.privateKey || !w.address || !w.merchantAddress) return null
    return {
      payer: getAddress(w.address),
      merchant: getAddress(w.merchantAddress),
      key: w.privateKey,
      mnemonic: w.mnemonic,
    }
  } catch {
    return null
  }
}

/** Derive the merchant (acct1) private key from the wallet mnemonic — the Tier-2 receipt signer. */
export function merchantKey(w) {
  const acct = mnemonicToAccount(w.mnemonic, { addressIndex: 1 })
  if (getAddress(acct.address) !== w.merchant) throw new Error('merchant key mismatch — wallet file is inconsistent')
  return '0x' + Buffer.from(acct.getHdKey().privateKey).toString('hex')
}

export const pub = createPublicClient({ chain: base, transport: http(RPC) })
const erc20 = [{ name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] }]
export const usdcBalance = (who) => pub.readContract({ address: getAddress(USDC), abi: erc20, functionName: 'balanceOf', args: [getAddress(who)] })
export const ethBalance = (who) => pub.getBalance({ address: getAddress(who) })

/** A fixed, well-known throwaway key for OFFLINE shape checks that need a relayer/buyer key but
 *  spend nothing. NEVER funded — only used to derive an address for an offline assertion. */
export const DUMMY_KEY = '0x' + '11'.repeat(32)

export { getAddress, formatUnits, formatEther }
