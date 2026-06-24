/**
 * `create-piprail` — the seller's zero-code on-ramp, the mirror of `npx -y @piprail/mcp` (the buyer's).
 * One command scaffolds a self-hosted x402 merchant that accepts stablecoin payments — from humans AND
 * AI agents — straight to your wallet. Paste a PUBLIC address (no key, no account); the config is baked
 * into the generated `src/gate.mjs`, mainnet by default.
 *
 *   npm create piprail@latest            # interactive
 *   npm create piprail -- my-shop --sell api --chain base --pay-to 0xYou --host cloudflare --yes
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { render, type Host, type ScaffoldConfig, type Sell } from './render.js'

type FlagValue = string | boolean
type Flags = Record<string, FlagValue>

const SELLS: readonly Sell[] = ['api', 'tip']
const HOSTS: readonly Host[] = ['node', 'cloudflare']

/** A tiny argv parser: `--key value`, `--key=value`, `--flag`, plus positionals. */
function parseArgs(argv: string[]): { flags: Flags; positional: string[] } {
  const flags: Flags = {}
  const positional: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === undefined) continue
    if (a.startsWith('--')) {
      const eq = a.indexOf('=')
      if (eq !== -1) {
        flags[a.slice(2, eq)] = a.slice(eq + 1)
      } else {
        const next = argv[i + 1]
        if (next !== undefined && !next.startsWith('--')) {
          flags[a.slice(2)] = next
          i++
        } else {
          flags[a.slice(2)] = true
        }
      }
    } else {
      positional.push(a)
    }
  }
  return { flags, positional }
}

/** Read a flag as a string, or undefined if absent / a bare boolean. */
function strFlag(flags: Flags, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = flags[k]
    if (typeof v === 'string') return v
  }
  return undefined
}

async function ask(question: string, def?: string): Promise<string> {
  const { createInterface } = await import('node:readline/promises')
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const ans = (await rl.question(def ? `${question} (${def}) ` : `${question} `)).trim()
    return ans || def || ''
  } finally {
    rl.close()
  }
}

export async function run(argv: string[]): Promise<void> {
  const { flags, positional } = parseArgs(argv)
  const yes = Boolean(flags.yes || flags.y)
  const interactive = Boolean(process.stdin.isTTY) && !yes

  if (flags.testnet) {
    console.warn('warning: create-piprail templates MAINNET only — ignoring --testnet. Paste a mainnet chain + address.')
  }

  let name = positional[0] ?? strFlag(flags, 'name')
  if (!name && interactive) name = await ask('Project name?', 'my-piprail-merchant')
  name = (name || 'my-piprail-merchant').trim()

  let sell = strFlag(flags, 'sell') as Sell | undefined
  if (!sell && interactive) sell = (await ask('What are you selling? (api | tip)', 'api')) as Sell
  sell = sell ?? 'api'
  if (!SELLS.includes(sell)) throw new Error(`--sell must be one of: ${SELLS.join(', ')}`)

  let host = strFlag(flags, 'host') as Host | undefined
  if (!host && interactive) host = (await ask('Where will it run? (node | cloudflare)', 'node')) as Host
  host = host ?? 'node'
  if (!HOSTS.includes(host)) throw new Error(`--host must be one of: ${HOSTS.join(', ')}`)

  let chain = strFlag(flags, 'chain')
  if (!chain && interactive) chain = await ask('Which mainnet chain?', 'base')
  chain = (chain || 'base').trim()

  let token = strFlag(flags, 'token')
  if (!token && interactive) token = await ask('Token?', 'USDC')
  token = (token || 'USDC').trim()

  const amountDefault = sell === 'tip' ? '1.00' : '0.05'
  let amount = strFlag(flags, 'amount', 'min', 'price')
  if (!amount && interactive) amount = await ask(sell === 'tip' ? 'Minimum tip?' : 'Price?', amountDefault)
  amount = (amount || amountDefault).trim()

  let payTo = strFlag(flags, 'pay-to', 'payTo', 'payto')
  if (!payTo && interactive) payTo = await ask('Your receiving wallet address (PUBLIC — no key)?')
  payTo = (payTo || '').trim()
  if (!payTo) {
    throw new Error('A receiving wallet address is required: pass `--pay-to 0xYourPublicAddress` (or run interactively).')
  }

  const dir = resolve(process.cwd(), name)
  if (existsSync(dir) && !flags.force) {
    throw new Error(`Directory already exists: ${dir}\nUse --force to write into it anyway.`)
  }
  const pkgName = basename(dir).toLowerCase().replace(/[^a-z0-9._-]/g, '-') || 'piprail-merchant'

  const cfg: ScaffoldConfig = { name: pkgName, sell, chain, token, payTo, amount, host }
  const files = render(cfg)
  for (const [rel, content] of files) {
    const full = join(dir, rel)
    await mkdir(dirname(full), { recursive: true })
    await writeFile(full, content)
  }

  const rel = name
  console.log('')
  console.log(`Created ${pkgName} (${sell} on ${chain} ${token} -> ${payTo})`)
  console.log('')
  console.log('Next:')
  console.log(`  cd ${rel}`)
  console.log('  npm install')
  console.log('  npm run verify        # checks your config (no signing, no sending)')
  if (host === 'node') {
    console.log('  npm start             # serves the paid endpoint')
  } else {
    console.log('  npm run dev           # wrangler dev (local)')
    console.log('  npm run deploy        # deploy to YOUR Cloudflare account')
  }
  console.log('')
  console.log('Receiving needs only your public address — no key, no account. Docs: https://docs.piprail.com')
  console.log('')
}
