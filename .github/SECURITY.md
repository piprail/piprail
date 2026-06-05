# Security Policy

PipRail moves money. We take security seriously and welcome responsible disclosure.

## What PipRail is (and isn't)

`@piprail/sdk` and `@piprail/mcp` are **backendless and self-custodial**. There is no
PipRail server, no database, and no custody — the payer signs and broadcasts their own
transfer straight to the merchant's wallet, and the merchant verifies it locally against
their own RPC. PipRail never holds funds and never has access to your keys. This keeps the
attack surface small, but it also means **you are responsible for your own keys and RPC**.

## Supported versions

Security fixes land on the latest published minor of each package. Please reproduce on the
latest version before reporting.

| Package         | Supported            |
| --------------- | -------------------- |
| `@piprail/sdk`  | latest `1.x`         |
| `@piprail/mcp`  | latest `0.x`         |

## Reporting a vulnerability

**Please do not open a public issue, PR, or Discussion for a security report.**

Use either private channel:

1. **GitHub Private Vulnerability Reporting** — the **Security** tab → **Report a vulnerability**
   (preferred; keeps the report attached to the repo).
2. **Email** — [john.weeks.dev@gmail.com](mailto:john.weeks.dev@gmail.com) with `SECURITY:` in the subject.

Please include: affected package + version, the chain/family if relevant, a minimal
reproduction, the impact you believe it has, and any suggested fix. **Never include a real
private key, seed phrase, or mnemonic** — a redacted repro is always enough.

We aim to acknowledge within **72 hours** and to ship a fix or a clear mitigation plan within
**14 days** for confirmed, in-scope issues. We're happy to credit you in the release notes
(or keep you anonymous — your call).

## In scope

Issues in the code in this repository, especially:

- **Verification bypass** — anything that lets a request pass the gate without a valid,
  sufficient, recent, correctly-addressed on-chain payment (wrong amount/decimals, wrong
  token/recipient, stale or reused proof, forged challenge echo, partial-payment tricks).
- **Replay protection gaps** — a proof accepted more than once, or across challenges.
- **Spend-policy bypass (MCP / client)** — an agent spending past `maxAmount` / `maxTotal`
  or outside the `tokens` / `hosts` allowlists, or any path that sends on-chain before the
  policy check.
- **Key / secret leakage** — the SDK or MCP logging, serialising, or transmitting a private
  key, seed, or mnemonic anywhere (the MCP must keep stdout protocol-only and never print secrets).
- Dependency vulnerabilities that are actually reachable through PipRail's code paths.

## Out of scope

- Third-party RPC endpoints, blockchains, wallets, bridges, or facilitators themselves.
- Loss of funds from your own key mismanagement, a compromised machine, or a malicious RPC
  you configured.
- The marketing site content at piprail.com (report those as a normal issue).
- Theoretical issues without a realistic, reachable exploit path.

Thank you for helping keep the agent economy's payment rail safe.
