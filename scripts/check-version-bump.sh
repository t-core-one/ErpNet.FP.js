#!/usr/bin/env bash
#
# Refuse a change to shipped code that does not raise the version in package.json.
#
# WHY. The version in package.json is how a deployed box is identified: the
# service reports it, and the RPi deploy runbook keys off it. On 2026-09-14 all
# three shop nodes reported "1.0.3" while running three different trees, because
# a set of driver changes landed without a bump. At that point the version
# stopped meaning anything and the only way left to tell two builds apart was to
# checksum src/ on every box by hand.
#
# SCOPE. Only files that are actually deployed count — src/, tools/, wwwroot/ —
# because those are exactly what the deploy rsyncs to a device. Changing tests,
# CI or documentation ships nothing and needs no bump; keeping the rule narrow
# is what stops people disabling the hook.
#
# Usage:  check-version-bump.sh <base-ref> [head-ref]
# Exit:   0 = fine, 1 = needs a bump, 2 = could not evaluate
set -uo pipefail

BASE="${1:?usage: check-version-bump.sh <base-ref> [head-ref]}"
HEAD_REF="${2:-HEAD}"

SHIPPED_RE='^(src/|tools/|wwwroot/)'

read_version() { # <ref>
  git show "$1:package.json" 2>/dev/null \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).version||"")}catch{process.stdout.write("")}})' 2>/dev/null
}

if ! git rev-parse --verify --quiet "$BASE^{commit}" >/dev/null; then
  echo "check-version-bump: base '$BASE' is not a commit; skipping." >&2
  exit 0
fi

changed=$(git diff --name-only "$BASE".."$HEAD_REF" -- 2>/dev/null | grep -E "$SHIPPED_RE")
if [ -z "$changed" ]; then
  exit 0   # nothing that ships changed
fi

old=$(read_version "$BASE")
new=$(read_version "$HEAD_REF")

if [ -z "$new" ]; then
  echo "check-version-bump: cannot read version from $HEAD_REF:package.json" >&2
  exit 2
fi

if [ -z "$old" ]; then
  exit 0   # no baseline to compare against
fi

# Unchanged, or moved backwards. `sort -V` orders 1.0.9 before 1.0.10 correctly,
# which a plain string compare does not.
if [ "$old" = "$new" ] || [ "$(printf '%s\n%s\n' "$old" "$new" | sort -V | head -1)" != "$old" ]; then
  n=$(printf '%s\n' "$changed" | wc -l | tr -d ' ')
  echo
  echo "  ✗ Version not bumped."
  echo
  echo "    $n shipped file(s) changed, but package.json is still $new."
  printf '%s\n' "$changed" | sed 's/^/      /' | head -10
  [ "$n" -gt 10 ] && echo "      ... and $((n - 10)) more"
  echo
  echo "    Every build that reaches a device must be identifiable. The service"
  echo "    reports this version and the RPi deploy keys off it, so two boxes"
  echo "    claiming the same version must be running the same code."
  echo
  echo "    Fix:   npm version patch --no-git-tag-version && git add package.json"
  echo "           (then amend, or include it in the commit you are pushing)"
  echo
  echo "    Tests, CI and docs do not need a bump — only src/, tools/, wwwroot/."
  echo "    Genuine emergency: git push --no-verify"
  echo
  exit 1
fi

exit 0
