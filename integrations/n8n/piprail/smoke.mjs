// Offline smoke — runs in CI after build (the integrations-publish gate). No network, no wallet.
// Imports the BUILT node + credential and asserts their n8n shape is intact.
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'

const nodeMod = await import('./dist/nodes/Piprail/Piprail.node.js')
const credMod = await import('./dist/credentials/PiprailApi.credentials.js')

const Piprail = nodeMod.Piprail ?? nodeMod.default?.Piprail
const PiprailApi = credMod.PiprailApi ?? credMod.default?.PiprailApi
assert.ok(Piprail, 'Piprail node export present')
assert.ok(PiprailApi, 'PiprailApi credential export present')

const d = new Piprail().description
assert.equal(d.name, 'piprail', 'node name')
assert.equal(d.usableAsTool, true, 'usableAsTool (callable by AI Agent nodes)')
assert.equal(d.credentials[0].name, 'piprailApi', 'references the piprailApi credential')

const ops = d.properties.find((p) => p.name === 'operation').options.map((o) => o.value)
for (const op of ['pay', 'plan', 'quote', 'estimateCost']) {
  assert.ok(ops.includes(op), `operation "${op}" present`)
}

const cred = new PiprailApi()
assert.equal(cred.name, 'piprailApi', 'credential name')
assert.ok(
  cred.properties.some((p) => p.name === 'privateKey' && p.typeOptions?.password === true),
  'privateKey is a password field',
)

// The bundle must be self-contained (zero runtime deps): the SDK must be inlined, not required.
assert.ok(existsSync('./dist/nodes/Piprail/piprail.svg'), 'light icon copied to dist')
assert.ok(existsSync('./dist/nodes/Piprail/piprail.dark.svg'), 'dark icon copied to dist')

console.log(`✓ n8n-nodes-piprail smoke OK — node + credential shape intact (${ops.length} operations)`)
