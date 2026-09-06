#!/usr/bin/env node
/**
 * ── THE VERIFICATION GATE ───────────────────────────────────────────────────────────
 *
 *   npm run verify-gate          # everything that must be green before a commit or release
 *   npm run verify-gate --quick  # skip the site + docs builds (the slow half)
 *
 * The canonical gate is `sdk/STANDARDS.md` §6 and the `verify-gate` skill. Until now it was
 * a list of commands to copy by hand — and `RELEASING.md` told you to "never skip
 * `npm run verify-gate`", a script that did not exist, so following the release doc
 * literally produced `npm error Missing script`. Found by the sync checker's
 * npm-scripts rule; this file makes the instruction true.
 *
 * Order matters and is not arbitrary: the MCP resolves `@piprail/sdk`'s BUILT `dist`, so the
 * SDK must build before the MCP type-checks or builds. The site's `prebuild` runs the sync
 * checker, so a site build also proves the surfaces are in sync.
 */
import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const quick = process.argv.includes('--quick')

const C = process.stdout.isTTY && !process.env.NO_COLOR
const green = (s) => (C ? `\x1b[32m${s}\x1b[0m` : s)
const red = (s) => (C ? `\x1b[31m${s}\x1b[0m` : s)
const dim = (s) => (C ? `\x1b[2m${s}\x1b[0m` : s)
const bold = (s) => (C ? `\x1b[1m${s}\x1b[0m` : s)

const steps = [
  ['build:sdk', 'npm', ['run', 'build:sdk'], 'the MCP resolves the SDK’s built dist — always first'],
  ['typecheck', 'npm', ['run', 'typecheck'], 'SDK + MCP src'],
  ['typecheck:test (sdk)', 'npm', ['run', 'typecheck:test', '-w', '@piprail/sdk'], 'src + tests together'],
  ['typecheck:test (mcp)', 'npm', ['run', 'typecheck:test', '-w', '@piprail/mcp'], 'root typecheck does NOT cover MCP tests'],
  ['test:sdk', 'npm', ['run', 'test:sdk'], 'the canonical contract'],
  ['test:mcp', 'npm', ['run', 'test:mcp'], ''],
  ['build:mcp', 'npm', ['run', 'build:mcp'], ''],
  ['lazy-chunk invariant', null, null, 'the EVM bundle must pull in NO non-EVM chain lib'],
  ['viem-free protocol layer', null, null, 'the chain-agnostic core imports no chain SDK'],
  ['custody invariant', null, null, 'nobody-holds-it: no keys, no secrets, no telemetry in the rail'],
  ['ops scripts parse', null, null, 'the gitignored .claude/ + scripts/ tooling still compiles'],
  ['env loader tests', 'node', ['--test', 'scripts/load-env.test.mjs'], 'the credential parser has a contract'],
  ['sync', 'npm', ['run', 'sync'], 'every mirrored fact agrees with its source'],
  ['prose', 'npm', ['run', 'prose'], 'the site + docs carry no AI tells (no em dashes)'],
  ['clean-clone sync', null, null, '🔴 the same rules against ONLY what git ships — this is what Netlify runs'],
  ...(quick ? [] : [
    ['build site', 'npm', ['run', 'build'], 'also re-runs the sync guard as prebuild'],
    ['build docs', 'npm', ['run', 'build:docs'], ''],
  ]),
]

console.log(`\n${bold('PipRail verification gate')}${quick ? dim('  (--quick: skipping site + docs builds)') : ''}\n`)

let failed = 0
for (const [label, cmd, args, why] of steps) {
  process.stdout.write(`  ${label.padEnd(26)}`)

  if (label === 'viem-free protocol layer') {
    /*
     * STANDARDS.md section 6 and CLAUDE.md both state it: the protocol layer depends ONLY on
     * `drivers/types.ts` and must never import viem or any chain SDK. It is what makes the
     * driver abstraction real rather than aspirational — and it was enforced by a grep that a
     * human had to remember to paste.
     *
     * The file list is READ OUT OF STANDARDS.md rather than copied here. Hard-coding it would
     * create exactly the thing `npm run sync` exists to prevent: a second copy of a fact that
     * silently rots as modules are added. STANDARDS.md stays the owner.
     */
    let files = []
    try {
      const std = readFileSync(join(REPO, 'sdk/STANDARDS.md'), 'utf8')
      const line = std.split('\n').find((l) => l.includes('grep -lE') && l.includes('viem'))
      files = [...(line ?? '').matchAll(/src\/[A-Za-z0-9._/-]+\.ts/g)].map((m) => m[0])
    } catch {
      /* handled by the empty check below */
    }
    if (!files.length) {
      console.log(red('✗ FAIL') + dim('  could not read the module list from sdk/STANDARDS.md section 6'))
      failed++
      continue
    }
    const missing = files.filter((f) => !existsSync(join(REPO, 'sdk', f)))
    const leaking = files
      .filter((f) => existsSync(join(REPO, 'sdk', f)))
      .filter((f) => /from ['"]viem/.test(readFileSync(join(REPO, 'sdk', f), 'utf8')))
    // A renamed/deleted module silently shrinks the checked set — that is a rotted guard, not a pass.
    if (missing.length) {
      console.log(red('✗ FAIL') + dim(`  STANDARDS.md lists modules that no longer exist: ${missing.join(', ')}`))
      failed++
    } else if (leaking.length) {
      console.log(red('✗ FAIL') + dim(`  chain SDK imported by the protocol layer: ${leaking.join(', ')}`))
      failed++
    } else {
      console.log(green('✓') + dim(`  ${files.length} protocol modules, none import viem`))
    }
    continue
  }

  if (label === 'custody invariant') {
    /*
     * ── THE CUSTODY INVARIANT ──────────────────────────────────────────────────────
     *
     * PipRail's central promise is that NOBODY holds the money: the merchant receives with a
     * public address, the payer signs with their own key, and the rail never touches either.
     * That claim is the product, the positioning AND the legal position (FinCEN's four criteria
     * turn on whether an intermediary has "total independent control"; CLARITY's non-controlling
     * developer test asks the same thing). Every competitor CLAIMS non-custody. This makes ours
     * falsifiable — and it means a hosted signer or a fee on the payment path turns the build red
     * instead of quietly shipping.
     *
     * Like the viem guard, the module list is READ from STANDARDS.md so it can never rot into a
     * stale second copy.
     *
     * Comments are stripped before matching: client.ts DOCUMENTS that a caller may pass a TON or
     * Algorand mnemonic, which is the opposite of holding one. Matching raw text would fail on
     * the very sentence that explains the design.
     */
    const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

    let modules = []
    try {
      const std = readFileSync(join(REPO, 'sdk/STANDARDS.md'), 'utf8')
      const line = std.split('\n').find((l) => l.includes('grep -lE') && l.includes('viem'))
      modules = [...(line ?? '').matchAll(/src\/[A-Za-z0-9._/-]+\.ts/g)].map((m) => m[0])
    } catch {
      /* handled by the empty check below */
    }
    if (!modules.length) {
      console.log(red('✗ FAIL') + dim('  could not read the module list from sdk/STANDARDS.md section 6'))
      failed++
      continue
    }

    const problems = []

    // 1 · No key material in the protocol layer. Keys enter ONLY at a caller-supplied
    //     drivers/<family>/wallet.ts — never in the modules that route and verify.
    const KEY = /\b(privateKey|secretKey|mnemonic|seedPhrase|keystore)\b/
    const holding = modules
      .filter((f) => existsSync(join(REPO, 'sdk', f)))
      .filter((f) => KEY.test(stripComments(readFileSync(join(REPO, 'sdk', f), 'utf8'))))
    if (holding.length) problems.push(`key material in the protocol layer: ${holding.join(', ')}`)

    // 2 · Receiving stays credential-free. The whole "nothing to sign up for" claim on
    //     piprail.com is this line: a merchant gate takes an ADDRESS, never a secret.
    //     Coinbase's equivalent requires a CDP API key; if we ever add one, that copy is a lie.
    const server = stripComments(readFileSync(join(REPO, 'sdk/src/server.ts'), 'utf8'))
    if (/^\s{2}(apiKey|secret|privateKey|credentials)\??:/m.test(server)) {
      problems.push('the merchant gate now asks for a secret — the "no account, no API key" claim is broken')
    }

    // 3 · No phone-home. A rail that reports back is a rail with a customer relationship.
    const TELEMETRY = /\b(sendBeacon|posthog|mixpanel|amplitude|datadogRum)\b|analytics\.(track|identify)/
    const talkers = []
    const stack = [join(REPO, 'sdk/src')]
    while (stack.length) {
      const dir = stack.pop()
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, e.name)
        if (e.isDirectory()) stack.push(full)
        else if (e.name.endsWith('.ts') && TELEMETRY.test(stripComments(readFileSync(full, 'utf8')))) {
          talkers.push(full.replace(`${REPO}/sdk/`, ''))
        }
      }
    }
    if (talkers.length) problems.push(`telemetry in the SDK: ${talkers.join(', ')}`)

    /*
     * NOT asserted here, deliberately: "no code path can divert or skim a payment". There is no
     * honest mechanical test for it — the destination is whatever the verified challenge's
     * `payTo` says, which is a runtime fact. It is covered by the test suite instead
     * (verify() re-derives every checked field from the trusted `accept`). A green tick we
     * could not stand behind would be worse than no tick.
     */
    if (problems.length) {
      console.log(red('✗ FAIL') + dim(`  ${problems.join(' · ')}`))
      failed++
    } else {
      console.log(green('✓') + dim(`  ${modules.length} protocol modules hold no keys · gate needs no secret · no telemetry`))
    }
    continue
  }

  if (label === 'clean-clone sync') {
    /*
     * ── THE CLEAN-CLONE GUARD ──────────────────────────────────────────────────────
     *
     * Your working tree is NOT what Netlify builds. `.claude/` ships only an allowlist,
     * so most of it is present here and absent there — and the site's `prebuild` runs the
     * sync checker, which means a rule that reads a gitignored path passes forever locally
     * and FAILS THE PRODUCTION BUILD.
     *
     * That has now happened twice:
     *   · `surfaces-index` hard-failed on a missing `.claude/SURFACES.md`
     *   · `custody-claim-mirrors` threw ENOENT on the gitignored BRAND.md, because
     *     `read()` THROWS rather than returning falsy — so the obvious-looking
     *     `const src = read(f); return src && …` is not the guard it appears to be.
     *
     * The deploy runbook has a manual clean-clone test that catches this, but it costs an
     * `npm ci` plus a human remembering. This re-runs the SAME rules with the resolvers
     * pretending untracked files don't exist (`git ls-files` is the authority), in about a
     * second. Build outputs stay visible, because the real build makes them before sync runs.
     *
     * If this step fails but `sync` passed, the rule is reading something git does not ship:
     * guard it with `exists()` first, or stop reading it.
     */
    const r = spawnSync('npm', ['run', '--silent', 'sync'], {
      cwd: REPO,
      encoding: 'utf8',
      env: { ...process.env, PIPRAIL_SYNC_CLEAN_CLONE: '1', NO_COLOR: '1' },
    })
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
    /*
     * No git? Then we cannot know what "tracked" means, and every rule would report a
     * false failure. That is not a code problem, so SKIP loudly rather than fail the gate
     * — this happens in a tarball install or an unpacked archive (exactly what the manual
     * clean-clone test creates, where the real `npm run sync` is the better check anyway).
     */
    if (out.includes('needs a git repo')) {
      console.log(dim('— SKIP  not a git repo, so "what git ships" is unknowable here'))
      continue
    }
    if (r.status === 0) {
      const m = out.match(/(\d+) in sync(?: · (\d+) skipped)?/)
      console.log(green('✓') + dim(`  ${m ? m[0] : 'clean'} against only what git ships`))
    } else {
      const offenders = out
        .split('\n')
        .filter((l) => l.includes('✗'))
        .map((l) => l.trim().replace(/^✗\s*/, '').split(' — ')[0])
      console.log(
        red('✗ FAIL') +
          dim(`  passes locally but NOT in a clean clone — a rule reads a gitignored path: ${offenders.join(', ') || 'see npm run sync'}`)
      )
      console.log(dim('           reproduce: PIPRAIL_SYNC_CLEAN_CLONE=1 npm run sync'))
      failed++
    }
    continue
  }

  if (label === 'ops scripts parse') {
    /*
     * Nothing else compiles the operational tooling. `typecheck` covers sdk/ + mcp/ only, and
     * `.claude/` is gitignored so no lint or CI ever sees it — a broken edit there stays broken
     * until someone runs the tool and gets a raw SyntaxError. That is not hypothetical: three
     * files were left unparseable during the 2026-08-28 credential refactor, and the only
     * symptom was the audit exiting 1 on a stack trace.
     */
    const files = []
    const stack = [join(REPO, '.claude/skills'), join(REPO, 'scripts')]
    while (stack.length) {
      const dir = stack.pop()
      let entries = []
      try {
        entries = readdirSync(dir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const e of entries) {
        if (e.name === 'node_modules' || e.name.startsWith('.')) continue
        const full = join(dir, e.name)
        if (e.isDirectory()) stack.push(full)
        else if (e.name.endsWith('.mjs')) files.push(full)
      }
    }
    const broken = files.filter(
      (f) => spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' }).status !== 0
    )
    console.log(
      broken.length
        ? red('✗ FAIL') + dim(`  ${broken.map((f) => f.replace(`${REPO}/`, '')).join(', ')}`)
        : green('✓') + dim(`  ${files.length} ops scripts parse`)
    )
    if (broken.length) failed++
    continue
  }

  if (cmd === null) {
    // The lazy-chunk grep: a static non-EVM import in the EVM bundle means a pure-EVM
    // install would download @solana/@ton/@stellar. Not covered by prepublishOnly — this
    // is the step people skip.
    const bundle = join(REPO, 'sdk/dist/index.js')
    let leak = false
    try {
      leak = /from ?['"]@(solana|ton|stellar)/.test(readFileSync(bundle, 'utf8'))
    } catch {
      console.log(red('✗ FAIL') + dim('  sdk/dist/index.js not built'))
      failed++
      continue
    }
    console.log(leak ? red('✗ FAIL') + dim('  non-EVM import leaked into the EVM bundle') : green('✓'))
    if (leak) failed++
    continue
  }

  const r = spawnSync(cmd, args, { cwd: REPO, encoding: 'utf8', shell: process.platform === 'win32' })
  if (r.status === 0) {
    // Surface the test counts rather than swallowing them — "1636 passed" is the useful bit.
    const counts = (r.stdout ?? '').match(/Tests\s+(\d+ passed[^\n]*)/)
    console.log(green('✓') + (counts ? dim(`  ${counts[1].trim()}`) : why ? dim(`  ${why}`) : ''))
  } else {
    failed++
    console.log(red('✗ FAIL'))
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim().split('\n').slice(-14).join('\n')
    console.log(dim(out.replace(/^/gm, '      ')))
  }
}

console.log(`\n${'─'.repeat(64)}`)
if (failed) {
  console.log(`  ${red(`${failed} step(s) FAILED`)} — do not commit or release.\n`)
  process.exit(1)
}
console.log(`  ${green('ALL GREEN')}${quick ? dim('  (run without --quick before a release)') : ''}\n`)
