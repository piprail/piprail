/**
 * L2 · MCP — the surface a MODEL actually drives.
 *
 * A model never constructs a `PipRailClient`. It gets whatever `@piprail/mcp` decides to hand
 * it, from environment variables somebody else set. So the authority story lives or dies here:
 *
 *   · `PIPRAIL_MODE` must produce the tool set it promises, and never a wider one;
 *   · a mode that claims supervision must actually WIRE supervision, not merely say so;
 *   · a contradiction between knobs must be refused loudly at boot, not resolved silently in
 *     whichever direction happens to be more permissive;
 *   · a key-less server must still boot read-only rather than crash or, worse, pretend it can pay.
 *
 * This drives `parseConfig` + `configToClientOptions` — the two functions that turn environment
 * into authority — and then asks what tools the resulting client would expose.
 */
export const meta = {
  id: 'mcp',
  layer: 'L2',
  what: 'PIPRAIL_MODE, confirm wiring, contradictory knobs, read-only boot, tool exposure',
  why: 'a model gets its authority from these env vars, so a mis-read here hands it the wallet',
}

const KEY = '0x' + '1'.repeat(64)

export async function run({ sdk, section, check, throws, REPO }) {
  const mcp = await import(`${REPO}/mcp/dist/index.js`)
  const { parseConfig, configToClientOptions, ConfigError, TOOL_NAMES } = mcp
  const { PipRailClient, paymentTools, AGENT_MODES } = sdk

  const env = (over = {}) => ({ PIPRAIL_CHAIN: 'base', PIPRAIL_PRIVATE_KEY: KEY, ...over })
  const cfgOf = (over) => parseConfig(env(over))
  /*
   * Build tools the way start.ts does: config → client options AND a serverOpts carrying
   * `confirm`. Constructing the client directly skips createMcpServer's `decorate()`, which is
   * what merges the elicitation hook in, so supervised would throw for the wrong reason.
   */
  const toolsFor = (over) => {
    const cfg = cfgOf(over)
    const { client } = mcp.createMcpServer(configToClientOptions(cfg), { confirm: cfg.confirm })
    return paymentTools(client).map((t) => t.name)
  }

  section('mcp · the mode knob produces the authority it promises')

  await check('no PIPRAIL_MODE defaults to budgeted, with eight tools', () => {
    const cfg = cfgOf({})
    const names = toolsFor({})
    return cfg.mode === 'budgeted' && names.length === 8
      ? '8 tools, budgeted' : { fail: `mode=${cfg.mode} tools=${names.length}` }
  })

  for (const mode of AGENT_MODES) {
    await check(`PIPRAIL_MODE=${mode} parses to ${mode}`, () => {
      // sovereign additionally demands its swap ceiling at parse time, so supply it.
      const cfg = cfgOf({ PIPRAIL_MODE: mode, ...(mode === 'sovereign' ? { PIPRAIL_MAX_PER_SWAP: '25.00' } : {}) })
      return cfg.mode === mode ? mode : { fail: `parsed as ${cfg.mode}` }
    })
  }

  await check('sovereign exposes the full fourteen', () => {
    const names = toolsFor({ PIPRAIL_MODE: 'sovereign', PIPRAIL_MAX_PER_SWAP: '25.00' })
    return names.length === 14 ? '14 tools' : { fail: `${names.length}: ${names.join(', ')}` }
  })

  await check('supervised and budgeted both stay at eight', () => {
    const sup = toolsFor({ PIPRAIL_MODE: 'supervised' })
    const bud = toolsFor({ PIPRAIL_MODE: 'budgeted' })
    return sup.length === 8 && bud.length === 8 ? '8 and 8' : { fail: `sup=${sup.length} bud=${bud.length}` }
  })

  section('mcp · a mode that claims supervision must WIRE supervision')

  await check('PIPRAIL_MODE=supervised turns confirmation ON by itself', () => {
    const cfg = cfgOf({ PIPRAIL_MODE: 'supervised' })
    return cfg.confirm === true
      ? 'confirm inferred from the mode'
      : { fail: '🔴 supervised without confirmation — it would pay without asking anyone' }
  })

  await check('the REAL boot path wires the hook and the server starts', () => {
    /*
     * start.ts turns the config into client options AND a serverOpts carrying `confirm`, and
     * it is createMcpServer's `decorate()` that merges the elicitation hook in. Testing
     * configToClientOptions alone would look like a missing hook when the wiring is fine, so
     * replicate the actual boot.
     */
    const cfg = cfgOf({ PIPRAIL_MODE: 'supervised' })
    const { client } = mcp.createMcpServer(configToClientOptions(cfg), { confirm: cfg.confirm })
    return client ? `server built, ${paymentTools(client).length} tools` : { fail: 'no client' }
  })

  await check('supervised WITHOUT the confirm wiring FAILS CLOSED', () => {
    // The SDK refuses a supervised client with no hook, so a boot path that forgot to wire
    // one crashes loudly at startup instead of quietly paying without asking anyone.
    const cfg = cfgOf({ PIPRAIL_MODE: 'supervised' })
    try {
      mcp.createMcpServer(configToClientOptions(cfg), { confirm: false })
      return { fail: '🔴 booted supervised with no approval hook' }
    } catch (e) { return `refused: ${e.constructor.name}` }
  })

  await check('sovereign boots through the real path too', () => {
    const cfg = cfgOf({ PIPRAIL_MODE: 'sovereign', PIPRAIL_MAX_PER_SWAP: '25.00' })
    const { client } = mcp.createMcpServer(configToClientOptions(cfg), { confirm: cfg.confirm })
    const names = paymentTools(client).map((t) => t.name)
    return names.length === 14 ? '14 tools on the real boot path' : { fail: `${names.length} tools` }
  })

  await check('budgeted does NOT silently turn confirmation on', () => {
    const cfg = cfgOf({ PIPRAIL_MODE: 'budgeted' })
    return cfg.confirm !== true ? 'confirm off, the policy is the consent' : { fail: 'budgeted forced confirmation' }
  })

  section('mcp · contradictory knobs are refused at BOOT, not resolved silently')

  await throws('supervised + PIPRAIL_CONFIRM=0 is refused', () =>
    cfgOf({ PIPRAIL_MODE: 'supervised', PIPRAIL_CONFIRM: '0' }))

  await throws('budgeted + PIPRAIL_CONFIRM=1 is refused', () =>
    cfgOf({ PIPRAIL_MODE: 'budgeted', PIPRAIL_CONFIRM: '1' }))

  await throws('an unknown PIPRAIL_MODE is refused (it must not fall back silently)', () =>
    cfgOf({ PIPRAIL_MODE: 'godmode' }))

  for (const typo of ['sovreign', 'SOVEREIGN', 'Sovereign', ' sovereign', 'super', '']) {
    await check(`PIPRAIL_MODE=${JSON.stringify(typo)} never yields sovereign authority`, () => {
      let names
      try { names = toolsFor({ PIPRAIL_MODE: typo }) }
      catch { return 'refused at boot' }
      return names.length <= 8 ? `${names.length} tools` : { fail: `🔴 ESCALATION: ${names.length} tools` }
    })
  }

  section('mcp · sovereign demands its ceiling, exactly as the SDK does')

  await check('sovereign WITHOUT a swap ceiling is refused', () => {
    try {
      const opts = configToClientOptions(cfgOf({ PIPRAIL_MODE: 'sovereign' }))
      new PipRailClient(Array.isArray(opts) ? opts[0] : opts)
      return { fail: '🔴 sovereign booted with nothing bounding a swap' }
    } catch (e) { return `refused: ${e.constructor.name}` }
  })

  await check('sovereign WITH a swap ceiling boots', () => {
    const names = toolsFor({ PIPRAIL_MODE: 'sovereign', PIPRAIL_MAX_PER_SWAP: '25.00' })
    return names.includes('piprail_swap') ? 'booted with the swap tools' : { fail: 'no swap tools' }
  })

  section('mcp · a key-less server boots READ-ONLY rather than pretending')

  await check('no private key still parses', () => {
    const cfg = parseConfig({ PIPRAIL_CHAIN: 'base' })
    return cfg ? 'parsed' : { fail: 'refused to parse without a key' }
  })

  await check('a read-only client exposes no ability to spend it does not have', () => {
    const cfg = parseConfig({ PIPRAIL_CHAIN: 'base' })
    const opts = configToClientOptions(cfg)
    const one = Array.isArray(opts) ? opts[0] : opts
    const c = new PipRailClient(one)
    // It may still LIST a pay tool; what matters is that it cannot derive an address to pay from.
    return c.address().then(
      (a) => ({ fail: `derived an address (${a}) with no key` }),
      (e) => `address() throws ${e.constructor.name}, as it must`
    )
  })

  section('mcp · the advertised tool list matches reality')

  await check('TOOL_NAMES matches what a budgeted client actually exposes', () => {
    const actual = toolsFor({})
    const declared = [...TOOL_NAMES]
    const missing = actual.filter((t) => !declared.includes(t))
    const extra = declared.filter((t) => !actual.includes(t))
    if (missing.length) return { fail: `exposed but not declared: ${missing.join(', ')}` }
    if (extra.length) return { fail: `declared but not exposed: ${extra.join(', ')}` }
    return `${actual.length} names agree`
  })

  section('mcp · malformed configuration fails loudly')

  await check('a malformed private key fails CLOSED on first use', async () => {
    // Key format is the driver's to judge, so it is checked lazily like the chain is. What
    // matters is that it can never silently produce a working-looking wallet.
    const opts = configToClientOptions(cfgOf({ PIPRAIL_PRIVATE_KEY: 'not-a-key' }))
    const c = new PipRailClient(Array.isArray(opts) ? opts[0] : opts)
    try { const a = await c.address(); return { fail: `derived an address from a junk key: ${a}` } }
    catch (e) { return `address() throws ${e.constructor.name}` }
  })

  for (const [label, over] of [
    ['an unknown chain', { PIPRAIL_CHAIN: 'not-a-chain' }],
    ['a negative max amount', { PIPRAIL_MAX_AMOUNT: '-1' }],
    ['a non-numeric max amount', { PIPRAIL_MAX_AMOUNT: 'lots' }],
    ['a negative swap ceiling', { PIPRAIL_MODE: 'sovereign', PIPRAIL_MAX_PER_SWAP: '-5' }],
  ]) {
    await check(`refuses ${label}`, () => {
      try {
        const cfg = cfgOf(over)
        const opts = configToClientOptions(cfg)
        new PipRailClient(Array.isArray(opts) ? opts[0] : opts)
        return { fail: 'accepted' }
      } catch (e) { return `refused: ${e.constructor.name}` }
    })
  }
}
