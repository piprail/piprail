// Suite 01 — protocol & transport.
// Proves the published bin speaks MCP correctly over real stdio: handshake,
// server identity, the 3 tool schemas, unknown-tool handling, config-error exits,
// and banner/stdout hygiene (a stray stdout byte would corrupt MCP framing).

import { VERSION } from '@piprail/mcp'
import { connectServer, runBinToExit, bootSnapshot } from '../lib/harness.mjs'
import { group, check, summarize } from '../lib/report.mjs'

const KEY = '0x' + '1'.repeat(64)
const DEAD_RPC = 'http://127.0.0.1:1'
const baseEnv = (over = {}) => ({ PIPRAIL_PRIVATE_KEY: KEY, PIPRAIL_CHAIN: 'base', PIPRAIL_RPC_URL: DEAD_RPC, ...over })

export async function run() {
  group('01 · Handshake, server identity & tool schemas (real subprocess + stdio)')
  {
    const s = await connectServer(baseEnv())
    try {
      const info = s.client.getServerVersion()
      check('server identifies as "piprail"', info?.name === 'piprail', JSON.stringify(info))
      check('reported version matches @piprail/mcp VERSION', info?.version === VERSION, `${info?.version} vs ${VERSION}`)

      const { tools } = await s.client.listTools()
      const names = tools.map((t) => t.name).sort()
      check('advertises exactly the 7 piprail tools (incl. budget + guide)',
        JSON.stringify(names) === JSON.stringify(['piprail_budget', 'piprail_discover', 'piprail_guide', 'piprail_pay_request', 'piprail_plan_payment', 'piprail_quote_payment', 'piprail_register']),
        names.join(', '))
      check('every tool has a description + object JSON-Schema',
        tools.every((t) => t.description && t.inputSchema?.type === 'object'))
      // The read tools with no target URL (search / budget / guide) take no required args;
      // the rest (quote / plan / pay / register) require `url`. All forbid extras.
      const NO_URL = ['piprail_discover', 'piprail_budget', 'piprail_guide']
      for (const t of tools) {
        if (NO_URL.includes(t.name)) {
          check(`${t.name}: all-optional args + forbids extra args`,
            !t.inputSchema.required && t.inputSchema.additionalProperties === false)
        } else {
          check(`${t.name}: requires \`url\` + forbids extra args`,
            t.inputSchema.required?.includes('url') && t.inputSchema.additionalProperties === false)
        }
      }
      const payTool = tools.find((t) => t.name === 'piprail_pay_request')
      check('pay tool exposes optional method + body params',
        Boolean(payTool.inputSchema.properties?.method) && Boolean(payTool.inputSchema.properties?.body))
      check('handshake + listTools succeeded ⇒ stdout is a clean protocol channel', names.length === 7)

      // Tool annotations reach a real MCP client over stdio (SDK ≥1.8.0 / MCP ≥0.2.2):
      // the reads are flagged read-only, and pay is flagged value-moving so a client
      // can render the right consent.
      const ann = Object.fromEntries(tools.map((t) => [t.name, t.annotations]))
      check('every tool advertises annotations with a human title',
        tools.every((t) => typeof t.annotations?.title === 'string'))
      check('the three reads are flagged readOnlyHint:true',
        ['piprail_discover', 'piprail_quote_payment', 'piprail_plan_payment'].every((n) => ann[n]?.readOnlyHint === true))
      check('piprail_pay_request is flagged value-moving (readOnly:false + destructive:true)',
        ann.piprail_pay_request?.readOnlyHint === false && ann.piprail_pay_request?.destructiveHint === true)
      check('piprail_register is a non-destructive write (readOnly:false + destructive:false)',
        ann.piprail_register?.readOnlyHint === false && ann.piprail_register?.destructiveHint === false)
    } finally {
      await s.close()
    }
  }

  group('01 · Dispatch — unknown tool never crashes the server')
  {
    const s = await connectServer(baseEnv())
    try {
      const res = await s.client.callTool({ name: 'does_not_exist', arguments: {} })
      check('unknown tool → isError result (not a thrown JSON-RPC error)',
        res.isError === true && JSON.stringify(res.content).includes('Unknown tool'))
    } finally {
      await s.close()
    }
  }

  group('01 · Config validation — bad config exits non-zero with a clear message')
  {
    const cases = [
      ['missing key', {}, /PIPRAIL_PRIVATE_KEY/],
      ['unknown chain', { PIPRAIL_PRIVATE_KEY: KEY, PIPRAIL_CHAIN: 'dogecoin' }, /Unknown chain/],
      ['typo in a PIPRAIL_ var', { PIPRAIL_PRIVATE_KEY: KEY, PIPRAIL_MAX_AMONT: '1' }, /Unknown PipRail config var/],
      ['non-decimal budget', { PIPRAIL_PRIVATE_KEY: KEY, PIPRAIL_MAX_AMOUNT: 'lots' }, /decimal/],
      ['malformed RPC URL', { PIPRAIL_PRIVATE_KEY: KEY, PIPRAIL_RPC_URL: 'not-a-url' }, /URL/],
      ['near without account id', { PIPRAIL_PRIVATE_KEY: KEY, PIPRAIL_CHAIN: 'near' }, /PIPRAIL_NEAR_ACCOUNT_ID/],
    ]
    for (const [label, env, re] of cases) {
      const { code, stdout, stderr } = await runBinToExit(env)
      check(`${label} → exit 1 + helpful stderr, empty stdout`,
        code === 1 && re.test(stderr) && stdout === '',
        `code=${code} stdoutLen=${stdout.length} stderr=${JSON.stringify(stderr.slice(0, 140))}`)
    }
  }

  group('01 · Boot banner — informative, secret-free, stderr-only')
  {
    const env = baseEnv({ PIPRAIL_MAX_AMOUNT: '0.25', PIPRAIL_MAX_TOTAL: '12.50', PIPRAIL_TOKENS: 'USDC,USDT' })
    const { stdout, stderr } = await bootSnapshot(env)
    check('banner announces the server', /PipRail MCP server/.test(stderr))
    check('banner shows chain + budget + tokens',
      /base/.test(stderr) && /0\.25/.test(stderr) && /12\.50/.test(stderr) && /USDC, USDT/.test(stderr))
    check('banner lists all 7 tools',
      /piprail_discover/.test(stderr) && /piprail_quote_payment/.test(stderr) && /piprail_plan_payment/.test(stderr) &&
        /piprail_pay_request/.test(stderr) && /piprail_register/.test(stderr) &&
        /piprail_budget/.test(stderr) && /piprail_guide/.test(stderr))
    check('banner reports the key SOURCE, never the value',
      /set via PIPRAIL_PRIVATE_KEY/.test(stderr) && !stderr.includes(KEY))
    check('a custom RPC URL is redacted to "(custom)"', /\(custom\)/.test(stderr) && !stderr.includes(DEAD_RPC))
    check('STDOUT stays empty until a request (clean MCP framing)', stdout === '', JSON.stringify(stdout.slice(0, 80)))
  }

  group('01 · Chain-aware default token (USDT where USDC does not exist)')
  {
    // No PIPRAIL_RPC_URL → the Tron rate-limit note should appear (boot is lazy,
    // so no network is touched). A custom RPC would correctly SUPPRESS that note.
    const s = await connectServer({ PIPRAIL_PRIVATE_KEY: KEY, PIPRAIL_CHAIN: 'tron' })
    try {
      check('Tron banner defaults tokens to USDT', /tokens\s+USDT/.test(s.stderr()))
      check('Tron banner prints a rate-limit note (no custom RPC set)', /Tron:.*rate-limited/i.test(s.stderr()))
    } finally {
      await s.close()
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await run()
  process.exit(summarize())
}
