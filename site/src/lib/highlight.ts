/**
 * Build-time syntax highlighting for `<CodeWindow />`.
 *
 * WHY THIS EXISTS
 * ───────────────
 * `CodeWindow` renders its `code` prop with `set:html`, expecting pre-highlighted markup:
 * the `tok-*` spans styled in global.css. Every snippet in `data/snippets.ts` was therefore
 * written with those spans typed BY HAND, which has two failure modes:
 *
 *   1. A new snippet written as plain text renders as plain text. Nothing errors, nothing
 *      warns. It just quietly looks worse than every other block on the site. That is
 *      exactly what happened to the two blocks on /facilitators.
 *   2. Hand-written markup goes through `set:html` unescaped, so a snippet containing a
 *      literal `<` or `&` renders as markup rather than as code.
 *
 * So: author snippets as PLAIN CODE and highlight them here. Escaping happens first and
 * unconditionally, which closes (2) as a side effect.
 *
 * This is deliberately a small tokenizer rather than a real parser. It highlights the
 * TypeScript/JSON we actually put on the site (imports, calls, strings, numbers, comments)
 * and when it does not recognise something it emits it as plain escaped text. The worst
 * output it can produce is under-highlighted, never wrong or unsafe.
 */

const ESCAPE: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;' }
const esc = (s: string) => s.replace(/[&<>]/g, (c) => ESCAPE[c]!)

const KEYWORDS = new Set([
  'import', 'from', 'export', 'default', 'const', 'let', 'var', 'function', 'return',
  'await', 'async', 'new', 'class', 'extends', 'implements', 'interface', 'type',
  'if', 'else', 'for', 'of', 'in', 'while', 'try', 'catch', 'finally', 'throw',
  'true', 'false', 'null', 'undefined', 'typeof', 'instanceof', 'as', 'void',
])

/*
 * One pass, one alternation. Order is load-bearing: comments and strings are matched BEFORE
 * anything else so that a keyword inside a comment, or a bracket inside a string, is never
 * re-tokenised. Anything the regex does not claim falls through to the gap handler and is
 * emitted as escaped plain text.
 */
const TOKEN = new RegExp(
  [
    '(\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/)',                   // 1 comment
    "('(?:[^'\\\\\\n]|\\\\.)*'|\"(?:[^\"\\\\\\n]|\\\\.)*\"|`(?:[^`\\\\]|\\\\.)*`)", // 2 string
    '(\\b\\d[\\d_]*\\.?\\d*n?\\b)',                             // 3 number
    '([A-Za-z_$][\\w$]*)(?=\\s*\\()',                           // 4 call target
    '([A-Za-z_$][\\w$]*)',                                      // 5 bare word (keyword or not)
  ].join('|'),
  'g',
)

const span = (cls: string, text: string) => `<span class="tok-${cls}">${esc(text)}</span>`

/**
 * Highlight one snippet.
 *
 * `chainKeys` are property names whose STRING VALUE gets the amber `tok-chain` treatment,
 * the site's one bit of semantic highlighting, so the eye lands on the chain in
 * `chain: 'solana'`. It is opt-out because a snippet about something else should not have a
 * random word turn amber.
 */
export function highlight(code: string, opts: { chainKeys?: string[] } = {}): string {
  const chainKeys = new Set(opts.chainKeys ?? ['chain'])
  let out = ''
  let last = 0

  /*
   * Is this string literal the value of one of `chainKeys`? Read straight back from the
   * SOURCE rather than tracking what was emitted: the property name is itself a token, so a
   * running "last thing emitted" tail only ever sees the colon.
   */
  const PROP_BEFORE = /([A-Za-z_$][\w$]*)\s*:\s*$/
  const isChainValue = (upTo: number) => {
    const m = PROP_BEFORE.exec(code.slice(0, upTo))
    return !!m && chainKeys.has(m[1]!)
  }

  for (const m of code.matchAll(TOKEN)) {
    const i = m.index!
    if (i > last) out += esc(code.slice(last, i))
    last = i + m[0].length

    if (m[1]) {
      out += span('com', m[1])
    } else if (m[2]) {
      out += span(isChainValue(i) ? 'chain' : 'str', m[2])
    } else if (m[3]) {
      out += span('num', m[3])
    } else if (m[4]) {
      // A call target that is also a keyword is a keyword: `if (x)`, `catch (e)`.
      out += span(KEYWORDS.has(m[4]) ? 'kw' : 'fn', m[4])
    } else if (m[5]) {
      out += KEYWORDS.has(m[5]) ? span('kw', m[5]) : esc(m[5])
    }
  }
  out += esc(code.slice(last))
  return out
}
