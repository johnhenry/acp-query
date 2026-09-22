# Agent playbook

`@johnhenry/acp-query` — a reactive session/turn store + permission broker for
the [Agent Client Protocol](https://agentclientprotocol.com). Single package,
Node >= 22 (see `engines.node`; the family standard is `>=26` but this repo
verifies on 22 in CI — a Phase 0 decision, not an oversight), Vitest
(`npm test`), builds to `dist/` via `tsc -p tsconfig.build.json`.
`session/request_permission` is the trust boundary: read `## Security model`
in `README.md` before touching `src/client.ts`'s permission or `gateWrites`
paths.

`CLAUDE.md` in this directory is a symlink to this file.

## The verification loop (before every push)

1. `npm run typecheck`
2. `npm test` — Vitest; no suite in this repo skips, so a skip in the output
   means something is actually broken, not just slow.
3. `npm run test:coverage`
4. `npm run build` — then `node -e "import('./dist/index.js').then(m => { if
   (!m.AcpQuery) throw new Error('missing export'); })"` (the same publish
   smoke check CI runs) and `npm pack --dry-run` to read the file list, not
   just the exit code.
5. A genuinely fresh clone:
   `git clone . /tmp/acp-query-verifyN && cd $_ && npm ci && npm run build && npm test`.
   This is the only way to catch "works on my checked-out tree" bugs —
   missing files in `package.json`'s `files`, undeclared deps.
6. Commit, push, close the issue with a comment naming the commit SHA.

CI (`.github/workflows/ci.yml`) runs `npm ci` → `npm run typecheck` →
`npm test` → `npm run test:coverage` → `npm run build` → the publish smoke
import, in that order; match it locally.

## Repo-specific gotchas

- **`@agentclientprotocol/sdk` is pinned to the exact string `1.3.0`, not a
  caret range, in `dependencies`/`peerDependencies` AND the `devDependencies`
  dev pin.** All three must move together. The SDK's own semver is
  independent of ACP's wire protocol version — bumping the pin does not by
  itself mean support for a new wire version; see the "Supported protocol
  versions" section of `README.md`.
- **With no `interactions` broker configured, permission requests fail safe
  to reject** — `resolvePermission()` in `src/client.ts` picks the first
  `reject_*` option the agent offered, or answers `{outcome: "cancelled"}` if
  it offered none. There is no default-allow path; do not add one as a
  convenience for tests — use `mockAcpAgent`'s helpers or a real
  `InteractionBroker` instead.
- **`fs`/`terminal` client capabilities are opt-in and unvalidated.** A
  handler is registered only for the callback you actually supply
  (`registerCapabilityHandlers`), and `gateWrites` (default `false`) routes
  only the *write* half (`fs/write_text_file`, `terminal/create`) through the
  broker before your callback runs — reads are never gated. acp-query ships
  no filesystem or process backend; do not assume any path/command
  validation exists unless your own callback does it.
- **ACP wire protocol v2 is deliberately unsupported.** A `schema-v2.0.0-alpha`
  is in flight upstream with breaking renames; this repo pins wire v1 only
  and tracks v2 readiness in [#5](https://github.com/johnhenry/acp-query/issues/5).
  Do not add v2-shaped fields or types speculatively — wait for #5.

## Definition of done

A change is done when all of the following hold, not just when tests pass:
- A regression test exists for any bug fixed — fixing a bug without a test
  that would have caught it means it can come back unnoticed.
- Anything the feature does **not** do is stated in `README.md` (the
  "Security model" or "Supported protocol versions" sections, as
  appropriate), not only in an issue comment.
- `CHANGELOG.md` has an entry citing the commit/PR.
- If `examples/` behavior changed, `examples/README.md`'s table is updated
  to match.

## Non-goals

- **ACP wire protocol v2 support** — tracked behind
  [#5](https://github.com/johnhenry/acp-query/issues/5) until the upstream
  schema stabilizes; see `README.md`'s "Supported protocol versions".
- **A built-in filesystem or process backend.** The `fs`/`terminal`
  capabilities are callback-only by design (`docs/design.md`, "Client
  capabilities: default OFF, user callbacks only") — acp-query will not ship
  a `node:fs` or `child_process` implementation.

## Releases

Bump `version` in `package.json` in a PR, add the `CHANGELOG.md` entry, merge,
then push a matching tag (`git tag v<version> && git push origin v<version>`)
— `.github/workflows/release.yml` triggers on `push: tags: ["v*"]` (not the
family's usual `release: published`; also runnable manually via
`workflow_dispatch`, which publishes whatever version is currently in
`package.json`). It gates on typecheck/test/build, verifies the tag matches
`package.json`'s version for tag-triggered runs, and is idempotent (`npm view`
pre-flight skips a version already on npm).
