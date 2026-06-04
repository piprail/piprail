import { describe, it, expect } from 'vitest'
import { evmDriver } from '../src/drivers/evm/index.js'
import { solanaDriver } from '../src/drivers/solana/index.js'
import { tonDriver } from '../src/drivers/ton/index.js'
import { stellarDriver } from '../src/drivers/stellar/index.js'
import { xrplDriver } from '../src/drivers/xrpl/index.js'
import { tronDriver } from '../src/drivers/tron/index.js'
import { suiDriver } from '../src/drivers/sui/index.js'
import { nearDriver } from '../src/drivers/near/index.js'
import { aptosDriver } from '../src/drivers/aptos/index.js'
import { algorandDriver } from '../src/drivers/algorand/index.js'

/**
 * describeAsset is the TRUSTED reverse-lookup (built-in token map + native) the
 * client's budget guard relies on — it must return the SDK's own decimals/symbol
 * for a recognised asset, and null for anything it can't price. Pure (no RPC), so
 * every family is exercised here offline.
 */
describe('describeAsset — trusted decimals/symbol per family (pure, no RPC)', () => {
  it('EVM: native, a built-in token (case-insensitive address), and an unknown asset', () => {
    const net = evmDriver.resolve({ chain: 'base' })!
    expect(net.describeAsset('native')).toEqual({ symbol: 'ETH', decimals: 18 })
    // Base USDC, lower-cased — must still match (EVM addresses are case-insensitive).
    expect(net.describeAsset('0x833589fcd6edb6e08f4c7c32d4f71b54bda02913')).toEqual({
      symbol: 'USDC',
      decimals: 6,
    })
    expect(net.describeAsset('0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef')).toBeNull()
    expect(net.describeAsset('not-an-address')).toBeNull()
  })

  it('Solana: native SOL, built-in USDC mint, unknown mint', () => {
    const net = solanaDriver.resolve({ chain: 'solana' })!
    expect(net.describeAsset('native')).toEqual({ symbol: 'SOL', decimals: 9 })
    expect(net.describeAsset('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')).toEqual({
      symbol: 'USDC',
      decimals: 6,
    })
    expect(net.describeAsset('So11111111111111111111111111111111111111112')).toBeNull()
  })

  it('TON: native TON (9dp), built-in USD₮ master (6dp), unknown master', () => {
    const net = tonDriver.resolve({ chain: 'ton' })!
    expect(net.describeAsset('native')).toEqual({ symbol: 'TON', decimals: 9 })
    expect(net.describeAsset('EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs')).toEqual({
      symbol: 'USDT',
      decimals: 6,
    })
    expect(net.describeAsset('EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')).toBeNull()
  })

  it('Stellar: native XLM (7dp), built-in USDC asset id, unknown asset', () => {
    const net = stellarDriver.resolve({ chain: 'stellar' })!
    expect(net.describeAsset('native')).toEqual({ symbol: 'XLM', decimals: 7 })
    expect(
      net.describeAsset('USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN')
    ).toEqual({ symbol: 'USDC', decimals: 7 })
    expect(net.describeAsset('FOO:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN')).toBeNull()
  })

  it('XRPL: native XRP (6dp), built-in USDC asset id, unknown asset', () => {
    const net = xrplDriver.resolve({ chain: 'xrpl' })!
    expect(net.describeAsset('native')).toEqual({ symbol: 'XRP', decimals: 6 })
    expect(
      net.describeAsset('5553444300000000000000000000000000000000:rGm7WCVp9gb4jZHWTEtGUr4dd74z2XuWhE')
    ).toEqual({ symbol: 'USDC', decimals: 6 })
    expect(net.describeAsset('FFFF:rGm7WCVp9gb4jZHWTEtGUr4dd74z2XuWhE')).toBeNull()
  })

  it('Tron: native TRX (6dp), TRC-20 USD₮ built-in (6dp), unknown', () => {
    const net = tronDriver.resolve({ chain: 'tron' })!
    expect(net.describeAsset('native')).toEqual({ symbol: 'TRX', decimals: 6 })
    expect(net.describeAsset('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t')).toEqual({ symbol: 'USDT', decimals: 6 })
    expect(net.describeAsset('TJRyWwFs9wTFGZg3JbrVriFbNfCug5tDeC')).toBeNull()
  })

  it('Sui: native SUI (9dp), built-in USDC coin type, unknown coin', () => {
    const net = suiDriver.resolve({ chain: 'sui' })!
    expect(net.describeAsset('native')).toEqual({ symbol: 'SUI', decimals: 9 })
    expect(
      net.describeAsset('0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC')
    ).toEqual({ symbol: 'USDC', decimals: 6 })
    expect(net.describeAsset('0xabc::foo::FOO')).toBeNull()
  })

  it('NEAR: built-in USDC + USDT (6dp), native NEAR (24dp), unknown', () => {
    const net = nearDriver.resolve({ chain: 'near' })!
    // Native NEAR is now a payment asset (digest-bound) — described as NEAR/24dp.
    expect(net.describeAsset('native')).toEqual({ symbol: 'NEAR', decimals: 24 })
    expect(
      net.describeAsset('17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1')
    ).toEqual({ symbol: 'USDC', decimals: 6 })
    expect(net.describeAsset('usdt.tether-token.near')).toEqual({ symbol: 'USDT', decimals: 6 })
    expect(net.describeAsset('unknown.near')).toBeNull()
  })

  it('Aptos: native APT (8dp), built-in USDC + USDT FA metadata (6dp), unknown', () => {
    const net = aptosDriver.resolve({ chain: 'aptos' })!
    expect(net.describeAsset('native')).toEqual({ symbol: 'APT', decimals: 8 })
    expect(
      net.describeAsset('0xbae207659db88bea0cbead6da0ed00aac12edcdda169e591cd41c94180b46f3b')
    ).toEqual({ symbol: 'USDC', decimals: 6 })
    expect(
      net.describeAsset('0x357b0b74bc833e95a115ad22604854d6b0fca151cecd94111770e5d6ffc9dc2b')
    ).toEqual({ symbol: 'USDT', decimals: 6 })
    expect(net.describeAsset('0xdeadbeef')).toBeNull()
  })

  it('Algorand: native ALGO (6dp), built-in USDC ASA id (6dp), unknown asset', () => {
    const net = algorandDriver.resolve({ chain: 'algorand' })!
    expect(net.describeAsset('native')).toEqual({ symbol: 'ALGO', decimals: 6 })
    expect(net.describeAsset('31566704')).toEqual({ symbol: 'USDC', decimals: 6 })
    expect(net.describeAsset('999999')).toBeNull()
  })
})
