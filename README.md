# @johnhenry/acpq — acp-query

**A reactive session/turn store + permission broker for the [Agent Client Protocol](https://agentclientprotocol.com).**

The official [`@agentclientprotocol/sdk`](https://github.com/agentclientprotocol/typescript-sdk)
gives you the wire: the fluent `client()` builder, typed handlers, stdio/HTTP/SSE/WebSocket
transports. `acpq` adds the state stratum an embedding app needs — for web UIs, notebooks,
dashboards, and editors hosting coding agents:

- **Reactive session store** — `session/update` streams fold into observable per-session
  state (`messageText`, `toolCalls` with live statuses, `plan`, `availableCommands`,
  `currentMode`, stop reasons, plus the raw update log). `subscribe()` is
  `useSyncExternalStore`-ready; hooks land next.
- **Permission broker** — ACP's `session/request_permission` (typed
  `allow_once/always` / `reject_once/always` options) routes through the shared
  [`InteractionBroker`](https://github.com/johnhenry/agent-query-core): trust policy
  auto-answers, "ask" queues for your approval UI (`resolve` with an `optionId`), every
  outcome audited. With no broker configured, requests **fail safe** (reject).
- **In-process mock agent** (`@johnhenry/acpq/testing`) — the SDK's own `agent()`
  builder wired straight to the client (`connect(mockAcpAgent(...))`): real protocol,
  no transport, with `say`/`toolCall`/`askPermission` turn helpers.

```ts
import { AcpQuery, InteractionBroker } from "@johnhenry/acpq";

const broker = new InteractionBroker();
const q = new AcpQuery({ interactions: broker });
q.connect(myAgentStream); // ndJsonStream over stdio, WebSocket, ... or an AgentApp

const sid = await q.newSession("/workspace");
q.subscribe(sid, () => render(q.session(sid))); // live turn state
await q.prompt(sid, "refactor the auth module");
// broker.list() -> pending permission requests for your approval inbox
```

## Docs & examples

- **[API reference](./docs/api.md)** — every export, with an example each
  (including the permission decision → wire mapping and the mock agent's helpers).
- **[Design](./docs/design.md)** — why ACP is a stream-**fold**, not a cache; the
  fold vocabulary; the full policy × options → outcome permission table; the
  cancel contract; what the SDK provides vs what acpq adds.
- **[`examples/`](./examples)** — six graded, runnable examples (in-process mock
  agent, no transport): basic turn → tool calls → permission inbox → policy
  rules → multi-session → cancel. `npm run example:01` … `example:06`.

Cancellation honors the ACP contract end to end: `cancel(sessionId)` sends
`session/cancel` **and** resolves that session's pending permission requests
with `{outcome: "cancelled"}`, so blocked turns finish with
`stopReason: "cancelled"` instead of hanging.

Status: **first slice** (`@agentclientprotocol/sdk@1.3.0` pinned, wire protocol v1).
Tracked next: React hooks, fs/terminal client handlers, devtools timeline, session
list/load caching, schema-v2 gate. Part of the
[agent-query family](https://github.com/johnhenry/agent-query-core) — shared engine
`@johnhenry/agent-query-core`; siblings `@johnhenry/mcpq` (MCP) and `@johnhenry/a2aq` (A2A).

MIT
