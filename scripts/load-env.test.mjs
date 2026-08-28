/**
 * Tests for the ONE env loader. Node's built-in runner — no new dependency:
 *
 *   node --test scripts/load-env.test.mjs      (also a step in `npm run verify-gate`)
 *
 * This file exists because the bug that motivated the loader was a PARSING bug: five
 * hand-rolled readers disagreed about surrounding quotes, so `RPC_TON='https://…'` reached
 * the SDK with the quotes attached and threw `TypeError: Invalid URL` — which reads exactly
 * like an SDK defect. A parser that silently mangles credentials deserves a contract.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseEnv } from './load-env.mjs'

test('strips one matching pair of surrounding quotes', () => {
  const e = parseEnv(`A='https://x/?k=1'\nB="https://y"\nC=https://z`)
  assert.equal(e.A, 'https://x/?k=1', 'single quotes must go — the whole reason this exists')
  assert.equal(e.B, 'https://y')
  assert.equal(e.C, 'https://z')
  for (const v of Object.values(e)) assert.ok(new URL(v), 'every value must still be a URL')
})

test('does NOT strip mismatched or inner quotes', () => {
  const e = parseEnv(`A='unterminated\nB=say "hi" there\nC="mixed'`)
  assert.equal(e.A, "'unterminated", 'a lone leading quote is data, not a wrapper')
  assert.equal(e.B, 'say "hi" there', 'inner quotes are part of the value')
  assert.equal(e.C, `"mixed'`, 'mismatched pair is left alone')
})

test('ignores comments and blank lines, keeps # inside a value', () => {
  const e = parseEnv(`# A=commented\n\n   # indented comment\nB=real\nC=pa#ss`)
  assert.equal(e.A, undefined, 'a commented line must not define a variable')
  assert.equal(e.B, 'real')
  assert.equal(e.C, 'pa#ss', '# is only a comment at the START of a line — passwords contain #')
})

test('handles values that legitimately contain =', () => {
  // Base64 secrets and query strings both do this; splitting on every = would truncate them.
  const e = parseEnv('TOKEN=abc==\nURL=https://h/p?a=1&b=2')
  assert.equal(e.TOKEN, 'abc==')
  assert.equal(e.URL, 'https://h/p?a=1&b=2')
})

test('tolerates surrounding whitespace and CRLF line endings', () => {
  const e = parseEnv('  A = spaced  \r\nB=crlf\r\n')
  assert.equal(e.A, 'spaced')
  assert.equal(e.B, 'crlf', 'a stray \\r must not end up inside the value')
})

test('accepts an empty value (an unset placeholder is not a parse error)', () => {
  const e = parseEnv('EMPTY=\nSET=x')
  assert.equal(e.EMPTY, '', '.env.example ships every key empty — that must parse')
  assert.equal(e.SET, 'x')
})

test('ignores lines that are not KEY=VALUE', () => {
  const e = parseEnv('just some prose\n=novalue\n2BAD=x\nGOOD=y')
  assert.equal(e.GOOD, 'y')
  assert.equal(e['2BAD'], undefined, 'a name cannot start with a digit')
  assert.equal(e[''], undefined)
})

test('accepts an optional `export ` prefix', () => {
  // Some .env files double as a shell `source` target. Skipping those lines would drop a
  // credential silently — the worst failure mode this parser could have.
  const e = parseEnv('export A=1\nexport   B="two"\nC=3')
  assert.equal(e.A, '1')
  assert.equal(e.B, 'two', 'quote-stripping still applies after export')
  assert.equal(e.C, '3')
})
