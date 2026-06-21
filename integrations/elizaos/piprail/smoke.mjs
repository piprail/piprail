// Offline smoke test of the built plugin — no wallet, no network. Asserts the plugin shape elizaOS
// expects: a name, a description, and the wrapped actions, each with a validate + handler.
import { piprailPlugin } from './dist/index.js'

const EXPECTED = ['PIPRAIL_PAY', 'PIPRAIL_QUOTE', 'PIPRAIL_PLAN', 'PIPRAIL_DISCOVER', 'PIPRAIL_BUDGET', 'PIPRAIL_GUIDE']
const actions = piprailPlugin.actions ?? []
const names = actions.map((a) => a.name)

const checks = [
  ['plugin name is "piprail"', piprailPlugin.name === 'piprail'],
  ['plugin has a description', typeof piprailPlugin.description === 'string' && piprailPlugin.description.length > 10],
  ['exposes every expected action', EXPECTED.every((n) => names.includes(n))],
  ['every action has a string description', actions.every((a) => typeof a.description === 'string' && a.description.length > 0)],
  ['every action has validate + handler fns', actions.every((a) => typeof a.validate === 'function' && typeof a.handler === 'function')],
  ['every action has similes', actions.every((a) => Array.isArray(a.similes) && a.similes.length > 0)],
]

let ok = true
for (const [label, pass] of checks) {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}`)
  if (!pass) ok = false
}
console.log(`\nactions (${names.length}): ${names.join(', ')}`)
if (!ok) { console.error('\nSMOKE FAILED'); process.exit(1) }
console.log('\nSMOKE PASSED')
