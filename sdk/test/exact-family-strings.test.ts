/**
 * Drift guard — the test that *should have caught* the stale "which families support `exact`"
 * strings (max-out deep-dive §E). The `exact` scheme is supported on FIVE families: EVM, Solana,
 * Algorand, Aptos, NEAR. Several agent-facing doc-strings used to name only three or four. This
 * asserts the corrected five-family wording is present and the known-stale forms are gone, so the
 * next family addition can't silently leave a string behind.
 *
 * The family lists wrap across two source lines, so we NORMALIZE the file (strip leading comment
 * markers + collapse whitespace) before matching — a line-by-line scan would false-fail on a
 * wrapped enumeration.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'

function normalize(relPath: string): string {
  const src = readFileSync(fileURLToPath(new URL(relPath, import.meta.url)), 'utf8')
  return src
    .replace(/^[ \t]*[/*]+[ \t]?/gm, ' ') // drop leading `//`, ` * `, `   *   ` comment markers
    .replace(/\s+/g, ' ') // collapse all whitespace (incl. newlines) so wrapped lists join
}

describe('exact-family enumerations name all five families (EVM, Solana, Algorand, Aptos, NEAR)', () => {
  const client = normalize('../src/client.ts')
  const guide = normalize('../src/agentGuide.ts')

  it('client.ts: the corrected five-family wordings are present', () => {
    // PaymentScheme doc + discover() doc (the two wrapped EIP-3009/SVM lists)
    expect(client).toContain('Solana SVM + Algorand + Aptos + NEAR')
    // the "can't pay exact" error messages (1595 + the reference 2373)
    expect(client).toContain('EVM, Solana, Algorand, Aptos + NEAR today')
  })

  it('client.ts: the known-stale (three/four-family) forms are gone', () => {
    expect(client).not.toContain('Solana SVM + Algorand,') // was "...+ Algorand, opt-in)"
    expect(client).not.toContain('Solana SVM + Algorand)') // was "...+ Algorand)."
    expect(client).not.toContain('Solana, Algorand + NEAR today') // was missing Aptos
  })

  it('agentGuide.ts: names all five families and drops the stale three-family form', () => {
    expect(guide).toContain('EVM, Solana, Algorand, Aptos + NEAR')
    expect(guide).not.toContain('EVM, Solana + Algorand')
  })
})
