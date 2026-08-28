#!/usr/bin/env bash
# ── ROTATE THE npm PUBLISH TOKEN, THEN RETRY THE FAILED RELEASE ──────────────────────
#
#   ./scripts/rotate-npm-token.sh            # rotate, then offer to re-run the last failed release
#   ./scripts/rotate-npm-token.sh --check    # diagnose only, change nothing
#
# WHY THIS EXISTS
# A release that dies with `404 Not Found - PUT https://registry.npmjs.org/@piprail%2fsdk` is an
# EXPIRED TOKEN, not a missing package: npm answers an unauthenticated publish with 404 rather
# than 401 so it never leaks whether a package exists. npm granular tokens expire on a 30/60/90-day
# default, so a token that has published happily for months simply stops one day.
#
# Nothing is half-published when this happens — npm rejected the whole request, the version number
# stays free, and the pushed tag stays valid. Rotate and re-run the SAME run; never bump the
# version or re-push the tag to work around it.
#
# SAFETY
#   · The token is read with `read -s` — never echoed, never written to a file, never in argv
#     (so it cannot leak into shell history, `ps`, or a log).
#   · It goes straight to `gh secret set`, which is write-only afterwards.
#   · This script never runs `npm publish`. Publishing stays tag-driven CI (CLAUDE.md).
set -euo pipefail

cd "$(dirname "$0")/.."
BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GREEN=$'\033[32m'; YEL=$'\033[33m'; OFF=$'\033[0m'
say() { printf '%s\n' "$*"; }

say ""
say "${BOLD}npm publish token — rotate + retry${OFF}"
say ""

# ── 1. diagnose ─────────────────────────────────────────────────────────────────────
say "${BOLD}Current state${OFF}"
LOCAL_VER=$(node -p "require('./sdk/package.json').version")
NPM_VER=$(npm view @piprail/sdk version 2>/dev/null || echo '(unreachable)')
say "  sdk/package.json : ${LOCAL_VER}"
say "  npm latest       : ${NPM_VER}"
if [ "$LOCAL_VER" = "$NPM_VER" ]; then
  say "  ${GREEN}✓ npm already serves this version — there may be nothing to publish.${OFF}"
fi
say "  NPM_TOKEN secret : $(gh secret list 2>/dev/null | awk '/^NPM_TOKEN/{print "present, created " $2}' || echo 'NOT SET')"

FAILED_RUN=$(gh run list --workflow=release.yml --limit 5 \
  --json databaseId,conclusion --jq '[.[] | select(.conclusion=="failure")][0].databaseId' 2>/dev/null || true)
[ -n "${FAILED_RUN:-}" ] && [ "$FAILED_RUN" != "null" ] \
  && say "  last failed run  : ${FAILED_RUN}" \
  || say "  last failed run  : none"

if [ "${1:-}" = "--check" ]; then say ""; say "${DIM}--check: nothing changed.${OFF}"; exit 0; fi

# ── 2. mint ─────────────────────────────────────────────────────────────────────────
say ""
say "${BOLD}Step 1 — mint a new token${OFF} ${DIM}(browser)${OFF}"
say "  npmjs.com → Access Tokens → ${BOLD}Generate New Token${OFF} → ${BOLD}Granular${OFF}"
say "    · Packages and scopes : ${BOLD}Read and write${OFF}"
say "    · Scope               : ${BOLD}@piprail${OFF}"
say "    · Expiry              : set one you will remember — this failure is an expiry"
say "  ${DIM}The account is 'johnweeks' and enforces 2FA on writes, so CI needs a token that${OFF}"
say "  ${DIM}bypasses 2FA (Automation, or Granular with 'Bypass 2FA').${OFF}"
say ""

# ── 3. store ────────────────────────────────────────────────────────────────────────
say "${BOLD}Step 2 — paste it below${OFF} ${DIM}(hidden; goes straight to GitHub, never to disk)${OFF}"
printf '  token: '
read -rs TOKEN
printf '\n'
[ -z "$TOKEN" ] && { say "${RED}  ✗ empty — nothing changed.${OFF}"; exit 1; }
case "$TOKEN" in
  npm_*) ;;
  *) say "${YEL}  ! that does not start with 'npm_' — npm tokens normally do. Continuing anyway.${OFF}" ;;
esac

printf '%s' "$TOKEN" | gh secret set NPM_TOKEN
unset TOKEN
say "${GREEN}  ✓ NPM_TOKEN updated (write-only from here).${OFF}"

# ── 4. retry ────────────────────────────────────────────────────────────────────────
if [ -n "${FAILED_RUN:-}" ] && [ "$FAILED_RUN" != "null" ]; then
  say ""
  say "${BOLD}Step 3 — re-run the failed release${OFF} ${DIM}(run ${FAILED_RUN}; the tag is already pushed)${OFF}"
  printf '  re-run now? [y/N] '
  read -r ANS
  case "$ANS" in
    y|Y)
      gh run rerun "$FAILED_RUN" --failed
      say "  watching…"
      gh run watch "$FAILED_RUN" --exit-status --interval 15 || true
      say ""
      say "  npm latest is now: $(npm view @piprail/sdk version 2>/dev/null || echo '?')"
      ;;
    *) say "  ${DIM}skipped — run it later: gh run rerun ${FAILED_RUN} --failed${OFF}" ;;
  esac
fi
say ""
