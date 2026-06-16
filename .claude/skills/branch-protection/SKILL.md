---
name: branch-protection
description: >-
  Manage and audit GitHub branch protection for PipRail's `main` via the `gh` API as
  reviewable Infrastructure-as-Code — the canonical ruleset spec lives in git, and every
  change is back-up-first, verify-after, and can-never-lock-you-out by design. Use whenever
  the task is "protect main", "lock down the main branch", "branch protection", "ruleset",
  "is main protected / still protected", "audit the branch rules", "did the protection drift",
  "someone forked the repo / GitHub says main is unprotected", "restore the branch rules", or
  "require reviews / signed commits / block force pushes". Read-only audit by default; mutations
  are guarded so nothing breaks.
---

# Branch protection — protect `main`, as code

**The single source of truth for how `main` is locked down, and the only safe way to change it.**
The live config is a GitHub **ruleset** (the modern replacement for classic branch protection).
This skill mirrors it into a checked-in JSON spec so the protection is reviewable, reproducible,
and restorable — and every command here is **back-up-first, verify-after**.

> **Golden rule: never click-edit the ruleset in the GitHub UI for a real change.** Edit
> [`protect-main.json`](protect-main.json), run **Apply**, let it verify. The UI is for one-off
> inspection only; the JSON is the truth.

---

## 0. Mental model — what this does and does NOT defend against

Read this before touching anything; it stops you from "fixing" a non-problem.

- **A fork cannot touch your `main`.** A fork is a separate copy under someone else's account.
  An **issue** is a comment thread. Neither changes a byte of your repo. The only way outside
  code lands is **you merging their pull request** by hand. GitHub's "unprotected branch" nudge
  is generic best-practice, not an alarm about a specific person.
- **Outsiders already can't push or merge** — that requires collaborator write access, which
  no one but the owner has. Branch protection does **not** grant "only I can merge"; that's
  already true. What it adds is discipline against the *real* risks:
  1. **You** force-pushing or committing straight to `main` (history-corruption footgun — see
     [[git-shallow-clone-amend-danger]]).
  2. A **future collaborator** doing the same.
  3. `main` being **deleted**.
  4. Code merging with **red CI** (only if you opt into required status checks — see §6 caveat).

So the protection here is mostly "protect the maintainer from their own accidents," and that is
exactly what a solo-maintainer OSS repo wants.

---

## 1. The facts (PipRail, current)

| Thing | Value |
|---|---|
| Repo | `piprail/piprail` (org-owned, public) |
| Ruleset name | `protect-main` |
| Ruleset id | `17756558` |
| Target | `~DEFAULT_BRANCH` (follows `main` even if renamed) |
| Enforcement | `active` |
| Rules | `deletion` · `non_fast_forward` (block force-push) · `pull_request` (0 approvals, all merge methods) · `required_signatures` |
| Bypass | **Repository admin role** (`actor_id 5`, `RepositoryRole`), mode `always` — this is what keeps you from locking yourself out |
| Classic branch protection | **none** (intentional — the ruleset is the only source of truth; don't add classic on top, they stack confusingly) |
| `gh` account needed | admin on `piprail/piprail` (currently `John-Weeks-Dev`) |

If the ruleset id ever changes (deleted + recreated), rediscover it:

```bash
gh api repos/piprail/piprail/rulesets --jq '.[] | select(.name=="protect-main") | .id'
```

---

## 2. Read-only — always safe, run these freely

### Status (human-readable)

```bash
gh api repos/piprail/piprail/rulesets/17756558 --jq '"name: \(.name)
enforcement: \(.enforcement)
targets: \(.conditions.ref_name.include)
rules: \([.rules[].type]|join(", "))
bypass: \([.bypass_actors[]|"role#\(.actor_id) (\(.bypass_mode))"]|join(", "))
can I bypass?: \(.current_user_can_bypass)"'
```

### Audit — does live match the committed spec? (drift detection)

```bash
SPEC=.claude/skills/branch-protection/protect-main.json
norm() { jq -S '{name,target,enforcement,conditions:.conditions,rules:(.rules|sort_by(.type)),bypass:(.bypass_actors|sort_by(.actor_id))}'; }
diff -u <(norm < "$SPEC") <(gh api repos/piprail/piprail/rulesets/17756558 | norm) \
  && echo "✓ IN SYNC — live protection matches the committed spec." \
  || echo "⚠ DRIFT — live differs from the spec (review the diff above)."
```

A clean `✓ IN SYNC` is the green light. Any diff means someone changed the ruleset in the UI
(or the spec was edited but not applied) — reconcile before doing anything else.

### Backup — snapshot the live ruleset to a timestamped file

```bash
mkdir -p .claude/skills/branch-protection/backups
gh api repos/piprail/piprail/rulesets/17756558 \
  > ".claude/skills/branch-protection/backups/protect-main.$(date +%Y%m%d-%H%M%S).json"
```

> `backups/` is for local safety snapshots — keep it gitignored or prune it; it is not the
> source of truth (`protect-main.json` is).

---

## 3. Apply — the ONLY safe way to change protection

Edit [`protect-main.json`](protect-main.json) first, then run this. It **(a)** refuses to proceed
unless the spec still keeps your admin bypass and active enforcement, **(b)** backs up the live
state, **(c)** applies, **(d)** verifies the result matches the spec, and **(e)** auto-restores
from the backup if anything diverges. This is proven idempotent — re-applying the current spec
changes nothing.

```bash
set -euo pipefail
RS=17756558; REPO=piprail/piprail
SPEC=.claude/skills/branch-protection/protect-main.json

# (a) SAFETY GUARDS — abort rather than risk a lockout / silent disable
jq -e '.bypass_actors[]? | select(.actor_id==5 and .actor_type=="RepositoryRole")' "$SPEC" >/dev/null \
  || { echo "✗ ABORT: spec drops the admin bypass — you could lock yourself out. Add it back."; exit 1; }
[ "$(jq -r .enforcement "$SPEC")" = "active" ] \
  || { echo "✗ ABORT: spec enforcement is not 'active' — protection would be off. Intentional? Edit by hand."; exit 1; }

# (b) backup
mkdir -p .claude/skills/branch-protection/backups
BK=".claude/skills/branch-protection/backups/protect-main.$(date +%Y%m%d-%H%M%S).json"
gh api "repos/$REPO/rulesets/$RS" > "$BK"; echo "✓ backed up → $BK"

# (c) apply
gh api --method PUT "repos/$REPO/rulesets/$RS" --input "$SPEC" >/dev/null && echo "✓ applied"

# (d) verify
norm() { jq -S '{name,target,enforcement,conditions:.conditions,rules:(.rules|sort_by(.type)),bypass:(.bypass_actors|sort_by(.actor_id))}'; }
if diff -u <(norm < "$SPEC") <(gh api "repos/$REPO/rulesets/$RS" | norm); then
  echo "✓✓✓ VERIFIED — live now matches the spec."
else
  # (e) auto-restore
  echo "‼️ MISMATCH — restoring from backup…"
  gh api --method PUT "repos/$REPO/rulesets/$RS" --input "$BK" >/dev/null
  echo "↩️ restored to pre-apply state. Investigate the spec before retrying."
  exit 1
fi
```

### If the ruleset doesn't exist yet (fresh repo / it was deleted)

Create it with the same spec, then capture the new id into this skill's facts table:

```bash
gh api --method POST repos/piprail/piprail/rulesets \
  --input .claude/skills/branch-protection/protect-main.json --jq '.id'
```

---

## 4. The spec ([`protect-main.json`](protect-main.json))

The committed JSON is a **perfect mirror** of the live ruleset (verified idempotent against the
API). Each rule, in plain English:

- `deletion` — `main` can't be deleted.
- `non_fast_forward` — **no force-pushes** to `main`. The single most valuable rule for this repo.
- `pull_request` with `required_approving_review_count: 0` — everything reaches `main` through a
  PR (clean audit trail, the only sane way to take outside contributions), but you can still
  merge your **own** PRs solo without waiting on a reviewer.
- `required_signatures` — every commit on `main` must be signed. You already have SSH commit
  signing set up ([[git-shallow-clone-amend-danger]]), so this is free insurance.
- `bypass_actors: [admin, always]` — you (Repository admin) can override in a pinch, so the rules
  prevent **accidents** without ever **locking you out**. Removing this turns the rules into hard
  walls for everyone including you — only do that deliberately.

---

## 5. Tightening later (when there are real co-maintainers)

Make these edits in the spec, then **Apply** (§3):

- **Require 1+ approving review** → set `pull_request.parameters.required_approving_review_count`
  to `1` (and consider `require_last_push_approval: true`). *Solo, leave it at 0 or you block
  yourself.*
- **Restrict who can push at all** → add a `repository_role`/team/user restriction. For an org
  repo you can also scope merge rights via team membership.
- **CODEOWNERS review** → add a `.github/CODEOWNERS`, then set `require_code_owner_review: true`.
- **Linear history** → add `{ "type": "required_linear_history" }` to `rules`.
- **Harden the bypass** → narrow `bypass_mode` to `pull_request` (admin can only bypass via a PR,
  not on direct push) instead of `always`, or remove the bypass entirely once you trust the flow.

---

## 6. ⚠️ The status-checks footgun (why we deliberately omit required CI)

`protect-main` intentionally does **not** require status checks. Reason: all three CI workflows
(`sdk.yml`, `mcp.yml`, `site.yml`) are **path-filtered** —

- `sdk.yml` runs only on `sdk/**`
- `mcp.yml` only on `mcp/**`
- `site.yml` only on `site/**`

Required status checks + path filters is a classic trap: **if a required check isn't triggered on
a PR, GitHub leaves that PR stuck forever** ("Expected — waiting for status to be reported").
A docs-only or `.claude/**` PR touches none of those paths → no check runs → un-mergeable. There
is no "skip if not run" for required checks.

**If you ever want true "CI must be green to merge":** first add a single always-runs aggregator
job (no path filter) that the three workflows report into, then require **only that one check**.
The check names, for reference, are `build + test + typecheck` (from both the `sdk` and `mcp`
workflows) and `build (CI check)` (from `site`). Type them exactly into the spec's
`required_status_checks` rule. Don't require the path-filtered ones directly.

---

## 7. Emergency — "did I lock myself out?"

With the current spec you basically **can't** be hard-locked: you have `always` bypass, and even
without it the rules still let you open and merge your own PRs (0 approvals) — they only block
force-push, deletion, and unsigned commits. But if a future tightened spec ever bites:

1. **You still have admin → restore a known-good backup** with a direct PUT (safe — backups carry
   active enforcement *and* your bypass):
   ```bash
   gh api --method PUT repos/piprail/piprail/rulesets/17756558 --input <backup.json>
   ```
2. **To deliberately switch protection OFF** (rare): the guarded Apply *refuses* this on purpose,
   so PUT by hand a copy of the spec with `"enforcement": "disabled"` (universally available), or
   `"evaluate"` to log-without-enforcing where your plan supports it. Re-Apply the real spec the
   instant you're done.
3. **Worst case → delete the ruleset entirely** (admin only — this removes ALL protection, so
   re-Apply immediately after):
   ```bash
   gh api --method DELETE repos/piprail/piprail/rulesets/17756558   # last resort
   ```

Never run the DELETE casually — it's the one command in this skill that removes protection rather
than verifying or restoring it.

---

## 8. Invariants this skill must never violate

1. **Back up before any mutation.** Every Apply snapshots live state first.
2. **Never drop the admin bypass** without an explicit, deliberate decision (the Apply guard
   enforces this).
3. **Keep `enforcement: active`** unless intentionally dry-running (`evaluate`) or disabling.
4. **Verify after every change** and auto-restore on mismatch.
5. **The JSON spec is the source of truth** — UI edits are drift; reconcile them back into the
   spec, don't let them diverge.
6. **One source of truth** — rulesets only; do not add classic branch protection on top.
