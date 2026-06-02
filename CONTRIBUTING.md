# Contributing to PipRail

Thanks for wanting to help — PipRail gets better with more chains, more examples, and more eyes on the code. Contributions are welcome under the [MIT License](LICENSE).

## Ground rules

- **Read [AGENTS.md](AGENTS.md) first** — commands, project layout, API ground truth, and the Always / Ask-first / Never list. (`sdk/STANDARDS.md` is the deeper build standard; `sdk/ERRORS.md` is the error standard.)
- **Keep it simple and backendless.** No backend, database, auth, or fee — that's the whole product.
- **The protocol layer stays chain-agnostic.** Chain libraries (`viem`, `@solana/*`, …) live only inside their `drivers/<family>/` folder.

## Develop

```bash
npm install
npm run build:sdk
npm run test:sdk      # Vitest — the tests are the contract
npm run typecheck
```

Adding a chain or token? Verify every address on-chain, mirror the existing driver structure (`chains · wallet · pay · verify · index`), add the tests first, and update the site. For anything large, open an issue before you build so we can agree on the approach.

## Sign your commits (DCO)

PipRail uses the **Developer Certificate of Origin** — a lightweight, sign-off-based way to certify you have the right to contribute what you're submitting. **No CLA, no copyright assignment.** Read it at <https://developercertificate.org>.

Add a sign-off to every commit:

```bash
git commit -s -m "your message"
```

That appends `Signed-off-by: Your Name <you@example.com>` (use your real name and email). By signing off you certify the DCO and license your contribution to the project under the MIT License.

## Submitting a PR

1. Fork, branch, make your change **with tests**.
2. Confirm `npm run test:sdk` and `npm run typecheck` pass.
3. Open a PR describing **what** changed and **why**.

That's it — thank you. 🚂
