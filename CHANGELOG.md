# Changelog

## 0.0.2 — dependency and docs fix (2026-08-25)

- **Bumped the `@johnhenry/agent-query-core` dependency to stable `0.1.0`.**
  The manifest published under `0.0.0` still pointed at the `0.1.0-rc.3`
  pre-release; this release is what actually ships the fix to consumers.
  Fixed in `fe4e050` (#9).
- **Fixed stale `@rc` install instructions and a hardcoded version in the
  README prose**, which had drifted from the published version. Fixed in
  `b51a9b1` (no PR — pushed directly to `main`).

(0.0.1 was never published under this name — that tag belonged to
pre-rename history.)

## 0.0.0 — npm scope migration (2026-08-23)

First release under this name. Renamed from `@johnhenry/acpq` during the
2026-08 agent-query family rename (`mcpq`/`a2aq`/`acpq` →
`mcp-query`/`a2a-query`/`acp-query`); the version line restarted at 0.0.0 on
rename — a new name and era, not a maturity signal. The old `@johnhenry/acpq`
versions are deprecated on npm.
