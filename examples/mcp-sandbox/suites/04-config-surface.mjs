// Suite 04 — the config & SDK-consumption surface, tested in-process via the
// PUBLIC exports of @piprail/mcp and @piprail/sdk. This is the exhaustive,
// data-driven proof that "everything the MCP grabs from the SDK" is wired right:
// every chain in CHAINS, every non-EVM family, every wallet format, the budget→
// policy mapping, the banner (incl. secret/RPC redaction), chain warnings, the
// version single-source-of-truth, and the SDK's paymentTools the server wraps.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import {
  parseConfig, configToClientOptions, walletInputFor, ConfigError,
  formatBanner, chainWarnings, TOOL_NAMES, VERSION, createMcpServer,
} from '@piprail/mcp'
import { CHAINS, paymentTools, PipRailClient } from '@piprail/sdk'
import { group, check, note, summarize } from '../lib/report.mjs'

const require = createRequire(import.meta.url)
const KEY = '0x' + '1'.repeat(64)
const NON_EVM = ['solana', 'ton', 'tron', 'near', 'sui', 'aptos', 'algorand', 'stellar', 'xrpl']
const TOOLS = ['piprail_pay_request', 'piprail_plan_payment', 'piprail_quote_payment']

export async function run() {
  group('04 · Defaults, aliases & coercion')
  {
    const def = parseConfig({ PIPRAIL_PRIVATE_KEY: KEY })
    check('defaults: base / 0.10 / 10.00 / USDC / unknown:false',
      def.chain === 'base' && def.maxAmount === '0.10' && def.maxTotal === '10.00' &&
        JSON.stringify(def.tokens) === '["USDC"]' && def.allowUnknownTokens === false)
    check('AGENT_KEY alias satisfies the key requirement', parseConfig({ AGENT_KEY: KEY }).keySource === 'AGENT_KEY')
    check('PIPRAIL_WALLET_KEY alias works', parseConfig({ PIPRAIL_WALLET_KEY: KEY }).keySource === 'PIPRAIL_WALLET_KEY')
    const csv = parseConfig({ PIPRAIL_PRIVATE_KEY: KEY, PIPRAIL_TOKENS: 'USDC, USDT ,EURC', PIPRAIL_HOSTS: 'api.x.com,*.y.com' })
    check('CSV tokens/hosts are split + trimmed',
      JSON.stringify(csv.tokens) === '["USDC","USDT","EURC"]' && JSON.stringify(csv.hosts) === '["api.x.com","*.y.com"]')
    check('allowUnknownTokens parses truthy (true/1/yes) vs falsey',
      parseConfig({ PIPRAIL_PRIVATE_KEY: KEY, PIPRAIL_ALLOW_UNKNOWN_TOKENS: 'yes' }).allowUnknownTokens === true &&
        parseConfig({ PIPRAIL_PRIVATE_KEY: KEY, PIPRAIL_ALLOW_UNKNOWN_TOKENS: 'no' }).allowUnknownTokens === false)
  }

  group('04 · Fail-fast validation')
  {
    const throws = (fn, re) => { try { fn(); return false } catch (e) { return e instanceof ConfigError && re.test(e.message) } }
    check('missing key throws ConfigError', throws(() => parseConfig({}), /PIPRAIL_PRIVATE_KEY/))
    check('typo in a PIPRAIL_ var throws', throws(() => parseConfig({ PIPRAIL_PRIVATE_KEY: KEY, PIPRAIL_MAX_AMONT: '1' }), /Unknown PipRail config var/))
    check('non-decimal budget throws', throws(() => parseConfig({ PIPRAIL_PRIVATE_KEY: KEY, PIPRAIL_MAX_AMOUNT: 'lots' }), /decimal/))
    check('bad RPC URL throws', throws(() => parseConfig({ PIPRAIL_PRIVATE_KEY: KEY, PIPRAIL_RPC_URL: 'not-a-url' }), /URL/))
    check('unknown chain throws', throws(() => parseConfig({ PIPRAIL_PRIVATE_KEY: KEY, PIPRAIL_CHAIN: 'dogecoin' }), /Unknown chain/))
    check('near without account id throws', throws(() => parseConfig({ PIPRAIL_PRIVATE_KEY: KEY, PIPRAIL_CHAIN: 'near' }), /NEAR_ACCOUNT_ID/))
  }

  group(`04 · Every EVM preset in CHAINS is accepted (${Object.keys(CHAINS).length} chains, data-driven)`)
  {
    const presets = Object.keys(CHAINS)
    check('CHAINS is a non-empty object including base + ethereum',
      presets.length > 0 && presets.includes('base') && presets.includes('ethereum'))
    let ok = 0
    for (const c of presets) {
      const cfg = parseConfig({ PIPRAIL_PRIVATE_KEY: KEY, PIPRAIL_CHAIN: c })
      if (cfg.chain === c && JSON.stringify(cfg.tokens) === '["USDC"]') ok++
    }
    check(`all ${presets.length} EVM presets accepted with USDC default`, ok === presets.length, `${ok}/${presets.length}`)
  }

  group('04 · Every non-EVM family is accepted, with the right default token')
  {
    let ok = 0
    for (const fam of NON_EVM) {
      const env = { PIPRAIL_PRIVATE_KEY: KEY, PIPRAIL_CHAIN: fam, ...(fam === 'near' ? { PIPRAIL_NEAR_ACCOUNT_ID: 'you.near' } : {}) }
      const cfg = parseConfig(env)
      const want = fam === 'tron' || fam === 'ton' ? 'USDT' : 'USDC'
      if (cfg.chain === fam && cfg.tokens[0] === want) ok++
    }
    check(`all ${NON_EVM.length} families accepted; Tron/TON default USDT, rest USDC`, ok === NON_EVM.length, `${ok}/${NON_EVM.length}`)
  }

  group('04 · Wallet-format mapping for every family (walletInputFor)')
  {
    const w = (chain, extra = {}) => walletInputFor({ chain, walletSecret: 'S', maxAmount: '0.1', maxTotal: '10', tokens: ['USDC'], allowUnknownTokens: false, keySource: 'x', ...extra })
    check('EVM/Tron/Sui/Aptos → { privateKey }',
      ['base', 'ethereum', 'tron', 'sui', 'aptos'].every((c) => JSON.stringify(w(c)) === '{"privateKey":"S"}'))
    check('Solana → { secretKey }', JSON.stringify(w('solana')) === '{"secretKey":"S"}')
    check('TON/Algorand → { mnemonic }', JSON.stringify(w('ton')) === '{"mnemonic":"S"}' && JSON.stringify(w('algorand')) === '{"mnemonic":"S"}')
    check('Stellar → { secret }, XRPL → { seed }', JSON.stringify(w('stellar')) === '{"secret":"S"}' && JSON.stringify(w('xrpl')) === '{"seed":"S"}')
    check('NEAR → { accountId, privateKey }', JSON.stringify(w('near', { nearAccountId: 'you.near' })) === '{"accountId":"you.near","privateKey":"S"}')
  }

  group('04 · Budget → spend policy (configToClientOptions)')
  {
    const cfg = parseConfig({ PIPRAIL_PRIVATE_KEY: KEY, PIPRAIL_CHAIN: 'base', PIPRAIL_MAX_AMOUNT: '0.5', PIPRAIL_MAX_TOTAL: '20', PIPRAIL_TOKENS: 'USDC,USDT', PIPRAIL_HOSTS: 'api.x.com', PIPRAIL_RPC_URL: 'https://rpc.example.com' })
    const opts = configToClientOptions(cfg)
    check('chain + wallet mapped onto client options', opts.chain === 'base' && JSON.stringify(opts.wallet) === `{"privateKey":"${KEY}"}`)
    check('budget became the PaymentPolicy (amount/total/tokens/hosts/unknown)',
      opts.policy.maxAmount === '0.5' && opts.policy.maxTotal === '20' &&
        JSON.stringify(opts.policy.tokens) === '["USDC","USDT"]' && JSON.stringify(opts.policy.hosts) === '["api.x.com"]' &&
        opts.policy.allowUnknownTokens === false)
    check('rpcUrl carried through', opts.rpcUrl === 'https://rpc.example.com')
  }

  group('04 · Banner formatting & redaction')
  {
    const cfg = parseConfig({ PIPRAIL_PRIVATE_KEY: KEY, PIPRAIL_MAX_AMOUNT: '0.25', PIPRAIL_MAX_TOTAL: '12.5', PIPRAIL_TOKENS: 'USDC,USDT', PIPRAIL_HOSTS: 'api.x.com', PIPRAIL_RPC_URL: 'https://rpc.example.com/v2/SUPER_SECRET', PIPRAIL_ALLOW_UNKNOWN_TOKENS: 'true' })
    const b = formatBanner(cfg)
    check('shows chain / per-payment / lifetime / tokens', /base/.test(b) && /0\.25/.test(b) && /12\.5/.test(b) && /USDC, USDT/.test(b))
    check('lists all 3 tools', TOOLS.every((t) => b.includes(t)))
    check('shows hosts row when set', /api\.x\.com/.test(b))
    check('flags allowUnknownTokens when on', /unknown tokens/i.test(b))
    check('NEVER leaks the secret', !b.includes(KEY))
    check('redacts a custom RPC URL (it can embed an API key)', /\(custom\)/.test(b) && !b.includes('SUPER_SECRET'))
    check('reports the key SOURCE only', /set via PIPRAIL_PRIVATE_KEY/.test(b))
  }

  group('04 · Chain warnings (advisory, non-fatal)')
  {
    const mk = (over) => parseConfig({ PIPRAIL_PRIVATE_KEY: KEY, ...over })
    check('TON without RPC → keyless-endpoint warning', chainWarnings(mk({ PIPRAIL_CHAIN: 'ton' })).some((w) => /rate-limited/i.test(w)))
    check('Tron without RPC → rate-limit warning', chainWarnings(mk({ PIPRAIL_CHAIN: 'tron' })).some((w) => /rate-limited/i.test(w)))
    check('TON WITH a custom RPC → no warning', chainWarnings(mk({ PIPRAIL_CHAIN: 'ton', PIPRAIL_RPC_URL: 'https://toncenter.com/api/v2/jsonRPC?api_key=x' })).length === 0)
    check('base → no warnings', chainWarnings(mk({ PIPRAIL_CHAIN: 'base' })).length === 0)
  }

  group('04 · Version single-source-of-truth + the SDK surface the server wraps')
  {
    // VERSION (version.ts) must match package.json AND server.json (release invariant).
    const pkgRoot = dirname(dirname(require.resolve('@piprail/mcp'))) // dist/index.js → dist → root
    const pkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'))
    check('VERSION matches @piprail/mcp package.json', VERSION === pkg.version, `${VERSION} vs ${pkg.version}`)
    try {
      const serverJson = JSON.parse(readFileSync(join(pkgRoot, 'server.json'), 'utf8'))
      const sv = serverJson.version ?? serverJson.packages?.[0]?.version
      check('VERSION matches server.json', sv === VERSION, `${sv} vs ${VERSION}`)
    } catch {
      note('server.json not present in this install — skipped (it ships in the published package)')
    }
    check('TOOL_NAMES is exactly the 3 piprail tools', JSON.stringify([...TOOL_NAMES].sort()) === JSON.stringify([...TOOLS].sort()))

    // paymentTools() is the SDK export the MCP turns into MCP tools.
    const client = new PipRailClient({ chain: 'base', wallet: { privateKey: KEY }, policy: { tokens: ['USDC'] } })
    const tools = paymentTools(client)
    check('SDK paymentTools(client) → 3 AgentTools (name/description/object-params/invoke)',
      tools.length === 3 && tools.every((t) => t.name && t.description && t.parameters?.type === 'object' && typeof t.invoke === 'function'))
    check('their names match what the server advertises', JSON.stringify(tools.map((t) => t.name).sort()) === JSON.stringify([...TOOLS].sort()))

    // createMcpServer wires client + server in-process (no transport, no network).
    const { server, client: c2 } = createMcpServer(configToClientOptions(parseConfig({ PIPRAIL_PRIVATE_KEY: KEY })))
    check('createMcpServer returns a wired { server, client }', Boolean(server) && c2 instanceof PipRailClient)
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await run()
  process.exit(summarize())
}
