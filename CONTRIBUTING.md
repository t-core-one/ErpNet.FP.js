# Contributing

## Bump the version in the same change that touches shipped code

If your change touches `src/`, `tools/` or `wwwroot/`, raise `version` in
`package.json` before it is pushed.

```bash
npm version patch --no-git-tag-version   # 1.0.3 -> 1.0.4
git add package.json
```

Tests, CI and documentation ship nothing to a device and need no bump.

### Why this is a rule and not a preference

This service runs on a Raspberry Pi in each shop, next to a fiscal printer.
There is no package registry and no image tag in between: deploying is an rsync
of `src/` plus `package.json`, and the running service reports its version over
HTTP. That version string is the only handle anyone has on "what is this box
actually running".

On 2026-09-14 all three shop nodes reported `1.0.3` while running three
different trees, because driver changes had landed without a bump. Telling the
builds apart meant checksumming `src/` on every box over SSH. In a shop, during
trading, with a fiscal device that has to keep issuing receipts, that is not a
diagnostic you want to be performing.

A version that does not change is worse than no version, because it actively
lies: two boxes reporting the same number look consistent when they are not.

### How it is enforced

- **`pre-push` hook** — `.githooks/pre-push`, enabled automatically by
  `npm install` (the `prepare` script points `core.hooksPath` at `.githooks`).
  It checks the range you are pushing, so local work-in-progress commits are
  unaffected; you can fix an omission with an amend before it reaches anyone.
- **CI** — `.github/workflows/ci.yml` runs the same script, because a hook can
  be skipped or never enabled.

Run it yourself at any time:

```bash
npm run check:version
```

In a genuine emergency `git push --no-verify` skips the hook — CI will still
flag it, which is the point: the exception stays visible instead of becoming
the norm.

## Tests

```bash
npm test
```

The suite covers the wire protocols with frames captured from real devices, so
it catches driver regressions without hardware. Please keep it green — several
of these tests exist because a defect reached a live shop, and the comment above
each one says which.
