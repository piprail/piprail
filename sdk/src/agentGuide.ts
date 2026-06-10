/**
 * The PipRail agent contract, distilled into one string an LLM can read once and
 * use the tools correctly with near-zero other docs. PURE — a static constant, no
 * imports, no I/O. Exposed to MCP clients as a prompt + resource, and reachable
 * from the tool layer so a headless (non-MCP) agent can prepend it to its system
 * prompt.
 *
 * Keep it tight, concrete, and tool-name-accurate — an agent will trust it
 * literally, so a wrong name or order actively misleads. A test pins the load-
 * bearing phrases.
 */
export const PIPRAIL_AGENT_GUIDE = `# Paying with PipRail — the agent contract

You can pay for x402 "402 Payment Required" resources autonomously. Money moves
straight from your wallet to the server; PipRail custodies nothing. Follow this.

## The loop: quote → plan → pay
1. piprail_quote_payment(url) — PRICE it. Returns the amount, token, chain, and
   whether it is within your spend policy. No funds move. Use it to decide if a
   resource is worth buying.
2. piprail_plan_payment(url) — can I afford it NOW? Reads your balance, native gas,
   and recipient-readiness across every rail, and returns { payable, best,
   fundingHint, session? }. If payable is false, do NOT attempt the payment —
   fundingHint says exactly what to fix.
3. piprail_pay_request(url, method?, body?) — PAY (only if the plan was payable)
   and return the result.
Always plan before you pay so you never commit to a payment you cannot finish.

## Reading a refusal — never crash, never double-spend
A failed pay returns a STRUCTURED object, never a thrown error you must catch:
  { ok:false, code, reason, explain, ref?, reasonCode?, declined? }
Branch on \`code\` (always reliable). Key cases:
- declined:true with reasonCode:'SESSION_EXPIRED' — your time budget is over. This
  is TERMINAL: STOP. Do not retry ANY payment this process; it cannot be undone
  without a restart / a longer TTL.
- declined:true with reasonCode:'APPROVAL' — a human (or hook) declined this
  payment. Terminal for this pay: do NOT auto-retry — they said no, or no one
  answered.
- declined:true with reasonCode:'OUTSIDE_WINDOW' — your rolling rate-limit is
  exhausted. Wait for it to free, then retry; do not raise the amount.
- declined:true with reasonCode:'POLICY' or 'BUDGET' — a spend cap or allowlist
  refused it. Don't retry the same payment; pick a cheaper/allowed one.
- code:'INSUFFICIENT_FUNDS' — top up the wallet (token and/or native gas), retry.
- code:'PAYMENT_TIMEOUT' / 'MAX_RETRIES_EXCEEDED' / 'CONFIRMATION_TIMEOUT' — the
  payment may ALREADY be on-chain. Recover using the proof on \`.ref\` (re-verify
  or re-submit it); never re-pay — a fresh payment would double-spend.
- code:'NO_COMPATIBLE_ACCEPT' / 'UNSUPPORTED_SCHEME' — the 402 isn't payable on
  your chain/scheme; \`explain\` says whether it's the wrong chain or a scheme to enable.

## Knowing your leash — call piprail_budget
piprail_budget tells you how much budget and time you have left, per
(network, asset), plus your spend so far. Read-only; moves no funds. Use it in
Mode A to self-check before paying.

## Two modes
- Mode A (headless, default): you run FREE inside a pre-set budget + time
  envelope. The policy IS the consent — there is no per-payment prompt. Stay
  inside it; piprail_budget shows what's left.
- Mode B (supervised): the host may ask a human to approve each payment. A
  decline/cancel/timeout comes back as declined:true (reasonCode:'APPROVAL') —
  do NOT retry it as if it were a transient error.

## Hard facts
- Spend caps are PER (network, asset). There is no single cross-token dollar cap —
  budgets aren't summed across tokens (no price oracle).
- Spend totals and the time envelope live IN-MEMORY for THIS process; they reset on restart
  (a convenience, not a durable ledger).
`

/** Returns {@link PIPRAIL_AGENT_GUIDE} (a parity accessor for callers that prefer a function). */
export function agentGuide(): string {
  return PIPRAIL_AGENT_GUIDE
}
