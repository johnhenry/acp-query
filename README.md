# @johnhenry/acp-query — acp-query

[![npm version](https://img.shields.io/npm/v/%40johnhenry%2Facp-query.svg)](https://www.npmjs.com/package/@johnhenry/acp-query)
[![CI](https://github.com/johnhenry/acp-query/actions/workflows/ci.yml/badge.svg)](https://github.com/johnhenry/acp-query/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/%40johnhenry%2Facp-query.svg)](LICENSE)

Full documentation: [opensource.johnhenry.me/agent-query/acp-query](https://opensource.johnhenry.me/agent-query/acp-query/)

**A reactive session/turn store + permission broker for the [Agent Client Protocol](https://agentclientprotocol.com).**

The official [`@agentclientprotocol/sdk`](https://github.com/agentclientprotocol/typescript-sdk)
gives you the wire: the fluent `client()` builder, typed handlers, stdio/HTTP/SSE/WebSocket
transports. `acp-query` adds the state stratum an embedding app needs — for web UIs, notebooks,
dashboards, and editors hosting coding agents:

- **Reactive session store** — `session/update` streams fold into observable per-session
  state (`messageText`, `toolCalls` with live statuses, `plan`, `availableCommands`,
  `currentMode`, stop reasons, plus the raw update log). `subscribe()` is
  `useSyncExternalStore`-ready, and `@johnhenry/acp-query/react` ships hooks
  (`useSession`, `useToolCalls`, `usePermissions`) built directly on it.
- **Permission broker** — ACP's `session/request_permission` (typed
  `allow_once/always` / `reject_once/always` options) routes through the shared
  [`InteractionBroker`](https://github.com/johnhenry/agent-query-core): trust policy
  auto-answers, "ask" queues for your approval UI (`resolve` with an `optionId`), every
  outcome audited. With no broker configured, requests **fail safe** (reject).
- **In-process mock agent** (`@johnhenry/acp-query/testing`) — the SDK's own `agent()`
  builder wired straight to the client (`connect(mockAcpAgent(...))`): real protocol,
  no transport, with `say`/`toolCall`/`askPermission` turn helpers.

```ts
import { AcpQuery, InteractionBroker } from "@johnhenry/acp-query";

const broker = new InteractionBroker();
const q = new AcpQuery({ interactions: broker });
q.connect(myAgentStream); // ndJsonStream over stdio, WebSocket, ... or an AgentApp

const sid = await q.newSession("/workspace");
q.subscribe(sid, () => render(q.session(sid))); // live turn state
await q.prompt(sid, "refactor the auth module");
// broker.list() -> pending permission requests for your approval inbox
```

Also ships: **React hooks** (`@johnhenry/acp-query/react` — `useSession`,
`useToolCalls`, `usePermissions`, plus the re-exported core hooks and
`<AgentQueryDevtools>` panel), **opt-in `fs`/`terminal` client capabilities**
(config-supplied callbacks only, default OFF, writes gated through the broker
via `gateWrites`), a **devtools wire tap** (`instrumentAcpStream` — every
JSON-RPC message alongside the semantic event stream), **`session/list` /
`session/load` / slash-command caching**, and **`AcpSessionHandle`**
(`attach()` / `newAttachedSession()` — bound-session ergonomics with a
`states()` async-iterable over folded snapshots).

## Contents

- [Install](#install)
- [Supported protocol versions](#supported-protocol-versions)
- [Docs & examples](#docs--examples)
- [Security model](#security-model)
- [Family](#family)

## Install

```sh
npm install @johnhenry/acp-query
```

Previously published as `@johnhenry/acpq`; the version line restarted at
`0.0.0` on the 2026-08 rename to this npm scope (see
[CHANGELOG.md](./CHANGELOG.md)).

## Supported protocol versions

acp-query supports **ACP wire protocol v1 only**. v2 (schema alpha as of this
writing) is explicitly out of scope until it stabilizes — tracked in
[#5](https://github.com/johnhenry/acp-query/issues/5).

- Built on **[`@agentclientprotocol/sdk@1.3.0`](https://github.com/agentclientprotocol/typescript-sdk)**,
  pinned exactly (both `dependencies`/`peerDependencies` and the dev pin) —
  not a caret range. The SDK's own semver (`1.3.0`) is independent of ACP's
  wire protocol version; acp-query tracks the SDK version, and the SDK reports
  `PROTOCOL_VERSION = 1`.
- The SDK package was renamed from `@zed-industries/agent-client-protocol`
  (now deprecated on npm) to `@agentclientprotocol/sdk` as governance moved
  out of Zed Industries into its own `agentclientprotocol` org. acp-query depends
  on the new package only.
- A `schema-v2.0.0-alpha` is in flight upstream with known breaking renames
  (semantic string types, diff patch → text, a terminal surface, `cancelled`
  variants). acp-query deliberately does **not** track or support it — issue #5
  stays open, watching for v2 to stabilize before any work starts.

## Docs & examples

- **[API reference](./docs/api.md)** — every export, with an example each
  (including the permission decision → wire mapping and the mock agent's helpers).
- **[Design](./docs/design.md)** — why ACP is a stream-**fold**, not a cache; the
  fold vocabulary; the full policy × options → outcome permission table; the
  cancel contract; observability (status semantics, devtools events, why
  `prompt()` is never retried); what the SDK provides vs what acp-query adds.
- **[`examples/`](./examples)** — eleven graded, runnable examples (in-process
  mock agent, no transport): basic turn → tool calls → permission inbox →
  policy rules → multi-session → cancel → devtools timeline → client
  capabilities → wire timeline → session list/load → attached session.
  `npm run example:01` … `example:11` (see [`examples/README.md`](./examples/README.md)
  for the full table).

Cancellation honors the ACP contract end to end: `cancel(sessionId)` sends
`session/cancel` **and** resolves that session's pending permission requests
with `{outcome: "cancelled"}`, so blocked turns finish with
`stopReason: "cancelled"` instead of hanging.

Status: **pre-1.0**, on `@agentclientprotocol/sdk@1.3.0`
pinned, wire protocol v1 — see `package.json` for the current published version
rather than trusting a number in prose, which drifts.

## Security model

acp-query sits on one real trust boundary: the permission broker that
decides whether an agent's `session/request_permission` calls (and, when
`gateWrites` is on, its `fs`/`terminal` write requests) actually go through.
It does not sandbox the agent process itself or validate what your own
`fs`/`terminal` callbacks do — it mediates *whether a request reaches your
code*, not what your code does with it.

**What acp-query guarantees:**

- **A permission request is never implicitly allowed.** With no
  `interactions` broker configured, `resolvePermission()` fails safe: it
  picks the first `reject_*` option the agent offered, or answers
  `{outcome: "cancelled"}` if it offered none — there is no default-allow
  path (`src/client.ts`, `resolvePermission`).
- **A gated write fails safe the same way.** With `gateWrites: true` and no
  broker configured, `gateWrite()` throws a `RequestError` (`-32000`) before
  your `fs`/`terminal` callback ever runs, denying the request outright
  instead of falling through to it (`src/client.ts`, `gateWrite`).
- **A capability is advertised only if a real callback backs it.**
  `clientCapabilities()` derives the `fs`/`terminal` flags purely from which
  callbacks you supplied in `AcpQueryConfig`, and `registerCapabilityHandlers()`
  registers a handler only for the callback actually provided — an agent
  cannot request a capability acp-query never wired in.
- **Cancelling a session always resolves its stuck permission requests.**
  `cancel(sessionId)` sends `session/cancel` and sweeps the broker's pending
  `"permission"` interactions for that session with `{action: "deny",
  cancelled: true, reason: "session/cancel"}`, so a cancelled turn can't
  leave a dangling approval prompt (`src/client.ts`, `cancel`).

**What is still yours:**

- **`gateWrites` is OFF by default, and even on, it only covers
  `fs/write_text_file` and `terminal/create`.** Every read method
  (`fs/read_text_file`, `terminal/output`, `terminal/wait_for_exit`, …)
  reaches your callback ungated, by design — "reads stay ungated by default
  because they are the high-frequency path" (`docs/design.md`). Gate a read
  yourself, inside your own callback, if your app needs it.
- **acp-query ships no filesystem or process backend at all.** The
  `fs`/`terminal` callbacks are entirely yours (`node:fs`, a browser shim,
  an in-memory fake) — acp-query does not validate paths, sanitize commands,
  or sandbox anything it hands you (`docs/design.md`, "Client capabilities:
  default OFF, user callbacks only").
- **The broker's correctness is whatever policy you inject.** An
  `InteractionBroker` whose policy callback returns `"allow"`
  unconditionally auto-clears every permission request and every gated
  write with nobody in the loop — acp-query only enforces that *something*
  is asked, not that the answer means anything.
- **A queued `"ask"` has no default timeout.** `resolvePermission()` and
  `gateWrite()` both call `interactions.gate()` without a `timeoutMs`, and
  the broker's default is to wait forever — an approval UI that never
  resolves leaves the agent's turn blocked until you `cancel()` the session
  or pass your own `timeoutMs`. We found no open issue tracking this
  specific gap at the time of writing — treat it as a documented caveat,
  not a promise of a future fix.

## Family

| Protocol | Library | Status |
|---|---|---|
| MCP | [`@johnhenry/mcp-query`](https://github.com/johnhenry/mcp-query) | published — sibling, shares `@johnhenry/agent-query-core` |
| A2A | [`@johnhenry/a2a-query`](https://github.com/johnhenry/a2a-query) | published — sibling, shares `@johnhenry/agent-query-core` |
| — | [`@johnhenry/agent-query-core`](https://github.com/johnhenry/agent-query-core) | published — the shared cache/broker/interceptor engine underneath acp-query |

MIT
