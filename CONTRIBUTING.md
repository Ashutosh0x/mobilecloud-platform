# Contributing

## Before you start

Open an issue describing the change. Security-sensitive paths — `apps/web-dashboard/lib/server/{api,oidc,oauth,passkey,qrlogin,sessions,scim,saml}.ts`,
`core-engine/src/terminal_gateway/`, `edge/mobilecloud-tunnel/` and
`contracts/por-verifier/` — need an explicit review from the owner in
`.github/CODEOWNERS`.

## Workflow

1. Branch from `main`; keep changes scoped to one subsystem.
2. Run the checks that apply:

```bash
cargo test
cd apps/web-dashboard && npm test && npx tsc --noEmit && npm run build
node scripts/integrity-manifest.mjs
node scripts/render-feature-status.mjs --check
```

3. Update `features/status.json` when a capability's real status changes, then
   regenerate `docs/FEATURE-STATUS.md`. Do not edit the generated table by hand.
4. If you touch a file listed in `INTEGRITY_MANIFEST.sha256`, regenerate it with
   `node scripts/integrity-manifest.mjs --write` and include the reason in the
   commit message.
5. Add tests for behaviour changes. A claim in the README without a test or a
   status entry is treated as marketing, not a feature.

## Style

- TypeScript: strict, explicit imports, `.ts` extensions for local imports.
- Rust: `cargo fmt`, no new `unsafe` without a comment explaining the invariant.
- Comments explain why, not what.
- Never log passwords, tokens, codes, private keys or personal data.

## Commit messages

`type(scope): summary`, then a short body explaining the security or user impact.
Commits that change auth, contracts or key handling must say what was tested.
