import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileSpendStore } from '../src/node.js'
import { SpendLedger, DENOM_PRECISION, type SpendRecord } from '../src/index.js'

const dirs: string[] = []
function tmpFile(name = 'spend.jsonl'): string {
  const dir = mkdtempSync(join(tmpdir(), 'piprail-'))
  dirs.push(dir)
  return join(dir, name)
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const rec = (over: Partial<SpendRecord> = {}): SpendRecord => ({
  url: 'https://api.example.com/r',
  host: 'api.example.com',
  network: 'eip155:8453',
  asset: '0xusdc',
  amountBase: '50000',
  amountFormatted: '0.05',
  symbol: 'USDC',
  decimals: 6,
  denom: 'USD',
  ref: '0xabc',
  at: '2026-06-02T00:00:00.000Z',
  ...over,
})

describe('fileSpendStore — durable local JSONL log', () => {
  it('round-trips records through a real file (append → load)', () => {
    const path = tmpFile()
    const store = fileSpendStore(path)
    expect(store.load()).toEqual([]) // no file yet
    store.append(rec())
    store.append(rec({ asset: '0xusdt', symbol: 'USDT', ref: '0x2' }))
    expect(existsSync(path)).toBe(true)
    const loaded = fileSpendStore(path).load()
    expect(loaded).toHaveLength(2)
    expect(loaded[0]).toMatchObject({ symbol: 'USDC', denom: 'USD', decimals: 6 })
  })

  it('rebuilds an exact ledger (totals + grand total survive a restart)', () => {
    const path = tmpFile()
    const a = new SpendLedger(fileSpendStore(path))
    a.record(rec(), 6, 'USD')
    a.record(rec({ asset: '0xusdt', symbol: 'USDT', ref: '0x2' }), 6, 'USD')
    // "Restart": a fresh ledger over the same file.
    const b = new SpendLedger(fileSpendStore(path))
    expect(b.count()).toBe(2)
    expect(b.totalFor('eip155:8453', '0xusdc')).toBe(50_000n)
    expect(b.totalForDenom('USD')).toBe(100_000n * 10n ** BigInt(DENOM_PRECISION - 6))
  })

  it('skips a corrupt line instead of failing the whole load', () => {
    const path = tmpFile()
    writeFileSync(path, `${JSON.stringify(rec())}\n{ not json }\n${JSON.stringify(rec({ ref: '0x2' }))}\n`)
    expect(fileSpendStore(path).load()).toHaveLength(2)
  })

  it('never throws on an unwritable path (append swallows the error)', () => {
    const store = fileSpendStore('/this/path/does/not/exist/spend.jsonl')
    expect(() => store.append(rec())).not.toThrow()
    expect(store.load()).toEqual([]) // unreadable → empty, not a crash
  })

  it('a JSON-valid-but-hostile line (bad amountBase) hydrates SAFELY — ledger skips it, no crash', () => {
    // fileSpendStore.load() returns it (it's valid JSON); the LEDGER must then skip the
    // un-tallyable record rather than throw BigInt(...) out of construction.
    const path = tmpFile()
    writeFileSync(
      path,
      `${JSON.stringify(rec())}\n${JSON.stringify(rec({ amountBase: '1e6', ref: 'bad' }))}\n${JSON.stringify(rec({ decimals: 999, ref: 'bad2' }))}\n`
    )
    let l: SpendLedger | undefined
    expect(() => { l = new SpendLedger(fileSpendStore(path)) }).not.toThrow()
    expect(l!.count()).toBe(1) // only the one good record survived
    expect(() => l!.summary()).not.toThrow()
  })
})
