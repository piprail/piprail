// Release invariant: the version is single-sourced. VERSION (version.ts, what the
// server reports over MCP + in its banner) MUST equal package.json AND server.json
// (top-level + packages[0]). This guard exists because 0.2.0 shipped with a stale
// VERSION ('0.1.0') — caught live by the mcp-sandbox; now it fails the gate locally.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { VERSION } from '../src/version.js'

const read = (p: string) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'))

describe('version single-source-of-truth', () => {
  const pkg = read('../package.json')
  const server = read('../server.json')

  it('VERSION === package.json version', () => {
    expect(VERSION).toBe(pkg.version)
  })

  it('VERSION === server.json version (top-level + packages[0])', () => {
    expect(server.version).toBe(VERSION)
    expect(server.packages[0].version).toBe(VERSION)
  })

  // The MCP registry rejects server.json with a description over 100 chars (HTTP 422).
  // Caught live in the field; this fails the gate locally so a too-long description can't ship.
  it('server.json description fits the MCP registry limit (<= 100 chars)', () => {
    expect(typeof server.description).toBe('string')
    expect(server.description.length).toBeLessThanOrEqual(100)
  })
})
