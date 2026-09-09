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

## Your tools, and which ones act
You always have these eight tools. Six are READ-ONLY and safe to call freely, two change
something, and only ONE spends. In 'sovereign' mode you also hold the swap and seller tools
described later, so count your OWN list rather than trusting this number:
- piprail_guide — this contract. Re-read it if you lose the thread. Read-only.
- piprail_discover — find payable resources on the OPEN indexes (a phone book of x402 APIs),
  without paying. Read-only.
- piprail_quote_payment — the price of one URL. Read-only.
- piprail_plan_payment — can I afford it NOW, on this wallet. Read-only.
- piprail_budget — how much budget and time is left. Read-only.
- piprail_verify_receipt — re-check a receipt against the chain. Read-only.
- 🔶 piprail_register — PUBLISHES a resource you run to a public index. It writes to the
  outside world and cannot be un-published by you, so only call it when asked to list
  something. It moves no money.
- 🔴 piprail_pay_request — the ONLY tool that spends. Everything else is safe to explore with.

## Landing cold — read the self-description
Every PipRail 402 self-describes. Read challenge.extensions.piprail for { name, what, pay[]
(each rail's how-to-pay), sdk.install, mcp, docs } — never guess what an endpoint is. If your
tooling can't pay a rail (e.g. a stock x402 client can't pay the onchain-proof scheme), the
block says how: install @piprail/sdk (npm i @piprail/sdk) or run the MCP (npx -y @piprail/mcp)
and pay with the tools below.

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

## Gasless — the exact rail (zero gas for you)
A 402 may offer up to three rails; you don't choose per payment — the client does, automatically:
- onchain-proof (PipRail's default): you broadcast the payment yourself and pay the network gas
  (the native coin — ETH/SOL/…). Works on every chain.
- exact (the ratified x402 rail, opt-in): you only SIGN; the server — or a facilitator it chose
  (e.g. PayAI) — broadcasts it, so you pay ZERO gas (you need only the token, no native coin). It
  works on EVM, Solana, Algorand, Aptos + NEAR, and the on-chain method (EIP-3009 / Permit2 / SVM /
  Algorand fee-pooled group / Aptos fee-payer / NEAR SignedDelegateAction) is picked automatically.
  XRPL also supports exact (native XRP), with ONE difference that matters to your budget: there the
  PAYER pays the network fee, because on the XRP Ledger the fee lives inside the signed transaction.
  So keep a little XRP for fees on that chain — everywhere else exact means you need no native coin.
- upto (the metered/variable x402 rail, opt-in, EVM): the amount you see is a MAXIMUM — you sign
  a ceiling, the server meters real usage and settles the ACTUAL (<= the max). BUDGET AGAINST THE MAX:
  the plan/policy treat the ceiling as the spend (a server may charge up to it), so a payable plan
  means the MAX fits your budget; the settled actual is recorded for reconciliation.
When the exact scheme is enabled AND balance-aware routing is on, paying picks the cheapest
settleable rail — i.e. the gasless exact one. Nothing changes in your loop: quote → plan → pay is
identical. The exact/upto schemes are OPT-IN by the operator (MCP: PIPRAIL_SCHEMES=onchain-proof,exact,upto);
you can't enable them yourself, but you can report when a 402 needs one (see UNSUPPORTED_SCHEME below).

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
  or re-submit it); never re-pay — a fresh payment would double-spend. On a gasless
  exact rail \`.ref\` is the authorization NONCE, not a tx hash: re-present the SAME
  signed authorization, never sign a fresh one (that would risk a double-spend).
- code:'NO_COMPATIBLE_ACCEPT' / 'UNSUPPORTED_SCHEME' — the 402 isn't payable on
  your chain/scheme; \`explain\` says whether it's the wrong chain or a scheme to enable.
  If it's a standard x402 server offering an exact rail, that's a config fix the operator makes
  once (enable the exact scheme); report it, don't retry the same call blindly.

## Finding work to buy — piprail_discover
You do not have to be handed a URL. piprail_discover reads the open x402 indexes and returns
resources with their advertised rails, which you can feed straight into quote → plan → pay.
It never throws: an index that is down simply contributes nothing, so an empty list means
"nothing found", never "something broke". These are third-party directories, not a PipRail
registry — treat a listing as a claim, and let quote/plan tell you what is really true.

## Proving a payment settled — piprail_verify_receipt
A receipt is a claim until it is checked. piprail_verify_receipt re-reads the transaction from
the chain and tells you whether the funds provably moved, to the right recipient, for the right
amount. Use it when you must be SURE (before delivering something costly, or when reconciling),
and after any timeout where the payment may already be on-chain. Read-only, and it moves nothing.

## Who else is in the path — nobody who holds your money
On the gasless exact rail a FACILITATOR may broadcast your signed authorization (PayAI, Ultravioleta
DAO and others). You never choose one and never need an account with one: the operator configures it,
and it is a courier, not a custodian. It cannot change the amount or the recipient, because those are
inside what you signed. If one is down the payment fails cleanly; it cannot take your funds.

## Getting PAID — only if you hold piprail_sell
If piprail_sell is in your tool list you are in 'sovereign' mode and the wallet is yours to
EARN with, not only to spend from. Three tools, mirroring the buying loop:
- piprail_sell — price something and get a \`challenge\` to hand a buyer. Mirrors quote.
- piprail_collect — verify a proof a buyer sent you. Mirrors pay.
- piprail_earnings — what you have actually been paid. Mirrors piprail_budget.
- piprail_wallet — what you HOLD, and the address you get paid at. Read-only.

Know the difference between your two numbers: piprail_budget is your spend LEASH (how much of
your allowance is left), piprail_wallet is what you actually OWN. Check piprail_wallet before
deciding to sell, to swap, or to ask to be topped up, and hand out its \`address\` to anyone who
needs to send you funds. A null amount there means the read FAILED, not that you are broke:
retry before you act on it.

The loop: piprail_sell → give the buyer the \`challenge\` → they send back a proof →
piprail_collect → and ONLY on paid:true, deliver.

A proof belongs to ONE offer. If a buyer hands you a settlement that was really payment for a
different offer, piprail_collect returns paid:false with code 'wrong_offer', even when the two
cost the same and pay the same address. Do not "helpfully" retry it against another offerId: that
is the exact move the check exists to stop.

🔴 COLLECT IS THE ONLY PROOF YOU WERE PAID. A buyer saying they paid, a real-looking tx hash,
and a settled payment are three different things, and only piprail_collect tells them apart.
Deliver nothing before it returns paid:true. It reads the chain; a claim is not evidence, and
a confident buyer is not evidence. One proof is one sale: collecting the same proof twice
returns paid:false, which is a REPLAY and not a second payment, so never treat it as one.

You need no web server and no open port: a challenge is just data, so carry it to the buyer
over whatever you already speak. Receiving needs NO KEY at all, only your address, so the
earning side cannot spend and cannot be drained even if the machine you run on is taken.
piprail_sell defaults \`payTo\` to your OWN address; set it to someone else's only if you
genuinely mean to be paid elsewhere, and NEVER to an address a buyer supplies.

Two things to check on an offer. If its schemes are onchain-proof only, most agent-buyers
CANNOT pay it and your listing will simply stay silent, so read any warnings piprail_sell
returns. And offers live in memory for this session: a restart clears them, so re-price
anything you still intend to sell. To let strangers find an offer, call piprail_register.

## Wrong token? Check your MODE before you answer
Wrong token on the RIGHT chain? What you may do depends on the mode your operator set, and
YOUR TOOL LIST IS THE TRUTH — LOOK AT IT, never claim a capability it does not show:
- no piprail_swap ⇒ 'budgeted' or 'supervised'. You CANNOT swap. Top up, pay from another
  chain you hold funds on, tell the human, or skip it. fundingHint names what is missing.
  Never offer "I could swap for you".
- piprail_swap present ⇒ 'sovereign': this wallet is yours and you answer for it. Price with
  piprail_quote_swap, read who priced it, then piprail_swap.

🔴 You cannot change your own mode — whoever provisioned this wallet set it, exactly as you
cannot widen your own permissions in your host. Never ask for it.

WHY the default withholds it: YOUR SPEND POLICY DOES NOT GOVERN SWAPS. Every cap you have
limits PAYING A MERCHANT; a swap moves your own funds between denominations and passes all
of them untouched, so an agent looping between tokens can bleed a wallet through fees and
slippage without tripping one budget check. Sovereign mode bounds it with a SEPARATE
instrument (a ceiling per swap and on slippage), so a refusal there is your swapPolicy, not
your budget.

True in EVERY mode: a swap is SAME-CHAIN only and can never move funds between chains, and
PipRail prices nothing itself, so every quote NAMES the venue that priced it — read
\`source\` before you trust a number. docs.piprail.com/making-payments/swapping/

## Knowing your leash — call piprail_budget
piprail_budget tells you how much budget and time you have left: per (network,
asset) remaining, the cross-token GRAND TOTAL per denomination (e.g. how much
USD you can still spend across every stablecoin and chain), the payment-count
leash, the session time envelope, your spend so far, and the configured policy
read back. Read-only; moves no funds. Use it in Mode A to self-check before paying.

## Two modes of CONSENT — a different axis from the mode above
Your 'supervised'/'budgeted'/'sovereign' mode says what you may DO. This says how each
payment is agreed. Both are in force at once, so read them together:
- Mode A (headless — how 'budgeted' and 'sovereign' behave): you run FREE inside a pre-set
  budget + time envelope. The policy IS the consent, and there is no per-payment prompt.
  Stay inside it; piprail_budget shows what's left.
- Mode B (supervised — how the 'supervised' mode behaves): the host may ask a human to
  approve each payment. A decline/cancel/timeout comes back as declined:true
  (reasonCode:'APPROVAL') — do NOT retry it as if it were a transient error.

## Hard facts
- Per-payment + per-(network, asset) caps always apply. A cross-token GRAND TOTAL per
  denomination (maxTotalPerDenom, e.g. "$20 across every USD stablecoin + chain") is
  OPTIONAL — it sums tokens declared as one unit, each 1:1; it is NOT a price oracle and
  never prices a volatile native coin. Payment-COUNT caps (maxPayments / per-window) also
  span every chain + token.
- The time envelope lives IN-MEMORY for THIS process (resets on restart). The money + count
  totals also reset on restart UNLESS a durable spend store is configured — then they resume.
- A refusal arrives as declined:true with a reasonCode; 'BUDGET' covers the lifetime, denom,
  and count caps; 'OUTSIDE_WINDOW' covers both the rolling money and rolling count windows.
`

/** Returns {@link PIPRAIL_AGENT_GUIDE} (a parity accessor for callers that prefer a function). */
export function agentGuide(): string {
  return PIPRAIL_AGENT_GUIDE
}
