# API reference — every export, with an example

The complete public surface of `@johnhenry/acpq`. Conceptual background lives in
[design.md](./design.md); runnable demos in [`examples/`](../examples).

- [`AcpQuery`](#acpquery)
  - [Construction](#construction) · [`connect` / `close`](#connect--close)
  - [`newSession` / `prompt` / `cancel`](#newsession--prompt--cancel)
  - [`listSessions` / `loadSession` / `commands`](#listsessions--loadsession--commands-cacheable-reads)
  - [`session` / `subscribe`](#session--subscribe-reactive-access)
  - [`attach` / `newAttachedSession` — `AcpSessionHandle`](#attach--newattachedsession--acpsessionhandle)
  - [`status` — peer connectivity](#status--peer-connectivity)
  - [Client capabilities: `fs` / `terminal` / `gateWrites`](#client-capabilities-fs--terminal--gatewrites)
  - [Devtools events](#devtools-events)
- [`SessionState` & `ToolCallState`](#sessionstate--toolcallstate)
- [Permissions: `PermissionDecision`, `PermissionOption`](#permissions)
- [Cache keys: `AcpKey`, `serializeAcpKey`, `sessionTag`](#cache-keys)
- [Re-exports from agent-query-core](#re-exports-from-agent-query-core)
- [`@johnhenry/acpq/testing` — `mockAcpAgent`](#johnhenryacpqtesting--mockacpagent)

---

## `AcpQuery`

The store/client. Owns a `ClientApp` (from the official SDK) with
`session/update` and `session/request_permission` handlers pre-wired, a
`QueryCache` of folded per-session state, and (optionally) an
`InteractionBroker` for human-in-the-loop permissions.

### Construction

```ts
import { AcpQuery, InteractionBroker } from "@johnhenry/acpq";

const q = new AcpQuery({
  name: "my-editor",                    // client identity advertised to agents (default "acpq")
  interactions: new InteractionBroker(),// optional permission broker — see below
  status: sharedStatusStore,            // optional; default: a fresh StatusStore
  devtools: new DevtoolsHub(),          // optional devtools sink; no-op when absent
});
```

`AcpQueryConfig`: `{ name?: string; interactions?: InteractionBroker<PermissionDecision>;
status?: StatusStore; devtools?: DevtoolsSink<AcpDevtoolsEvent>;
fs?: AcpFsHandlers; terminal?: AcpTerminalHandlers; gateWrites?: boolean }`.

Public readonly fields: `q.cache` (the `QueryCache<AcpKey>`), `q.interactions`,
`q.status` (the `StatusStore` — see below), `q.app` (the underlying SDK
`ClientApp`, for advanced composition — e.g. registering additional handlers
before connecting).

### `connect` / `close`

```ts
import { mockAcpAgent } from "@johnhenry/acpq/testing";

// In-process AgentApp (tests, examples) — or any SDK Stream (ndJsonStream
// over stdio, WebSocket, …). Both go through the same overload.
const conn = q.connect(mockAcpAgent(), { name: "claude-code" });
// …
await q.close();
```

- `connect(agentOrStream, opts?)` returns the SDK `ClientConnection`. One
  connection at a time: calling `connect()` while connected **throws** — call
  `close()` first. If the connection drops on its own, a fresh `connect()` is
  allowed.
- `ConnectOptions.name` labels the agent as the broker's `peer` — it is what
  policy callbacks, `broker.list()[n].peer`, and audit entries see. Default `"agent"`.
- `close()` closes the connection and **awaits full shutdown** (`conn.closed`).
  Idempotent; safe when never connected. Session states survive close — you can
  reconnect and keep reading them.

### `newSession` / `prompt` / `cancel`

```ts
const sid = await q.newSession("/workspace"); // session/new; state observable immediately

const stopReason = await q.prompt(sid, "refactor the auth module");
// "end_turn" | "cancelled" | … — also recorded as state.lastStopReason.
// session/update notifications stream into the state WHILE this is pending.

await q.cancel(sid); // session/cancel
```

`cancel(sessionId)` implements ACP's cancel contract: after sending
`session/cancel` it resolves any **pending broker interactions of type
"permission" for that session** with a cancelled decision, so the agent's
in-flight `session/request_permission` receives `{outcome: "cancelled"}`
(audited as `denied`, reason `"session/cancel"`) instead of hanging forever.
The turn then finishes and `prompt()` resolves with stop reason `"cancelled"`.

### `listSessions` / `loadSession` / `commands` (cacheable reads)

ACP's few *addressable reads* get the classic query-cache treatment:

```ts
const sessions = await q.listSessions();            // session/list — cached
await q.listSessions({ cwd: "/workspace" });        // separate entry per cwd filter
await q.listSessions({ force: true });              // bypass the cache

const state = await q.loadSession(sid, "/workspace"); // session/load — replay into a fresh fold

q.commands(sid);                  // a session's slash commands, as their own cache entry
q.subscribeCommands(sid, fn);     // notify only when the commands change
```

- **`listSessions(opts?)`** returns `SessionInfo[]` (the SDK's type),
  following `nextCursor` pagination to the end. Within
  `AcpQueryConfig.listStaleTime` (default 30 000 ms) of the last fetch, the
  cache answers without touching the agent; concurrent calls share one
  in-flight request. `newSession()` invalidates every list entry (they carry
  the exported `sessionsTag`); errors are recorded on the entry
  (`status: "error"`) and rethrown. Entries are keyed
  `{kind: "session-list", cwd?}` and observable via `q.cache`.
- **`loadSession(sessionId, cwd = "/")`** implements the family's
  reconcile-read rule: the agent replays the session's history as ordinary
  `session/update` notifications, so acpq **discards any pre-existing folded
  state first** — the replay is the complete truth, and folding onto leftovers
  would double-count. Subscribers stay attached and watch the replay live.
  Resolves with the replayed `SessionState`; `currentMode` is seeded from the
  response's mode state when reported.
- **`commands(sessionId)` / `subscribeCommands`** — `available_commands_update`
  folds also maintain a `{kind: "commands", id}` cache entry, so a command
  palette re-renders only when the commands change, not on every message
  chunk. (Still mirrored on `SessionState.availableCommands`.)

See [`examples/10-session-list-load.ts`](../examples/10-session-list-load.ts).

### `session` / `subscribe` (reactive access)

```ts
const unsub = q.subscribe(sid, () => {
  render(q.session(sid)); // called on every fold — snapshot is a fresh object
});
```

- `session(sessionId): SessionState | undefined` — current folded snapshot.
  Snapshots are replaced (never mutated) on each fold, so identity comparison
  works and the pair is `useSyncExternalStore`-ready.
- `subscribe(sessionId, fn): () => void` — notify on every state change;
  returns the unsubscribe function.

### `attach` / `newAttachedSession` — `AcpSessionHandle`

Bound-session sugar: a handle that pins one sessionId so you stop re-passing
it. **Pure delegation** — every method calls the corresponding `AcpQuery`
method, the store stays the single source of truth, and any number of handles
on the same id see identical state.

```ts
const h = await q.newAttachedSession("/workspace"); // newSession + attach
const h2 = q.attach(existingId);                    // any id: listSessions(), another client, …

h.sessionId;              // the bound id
await h.prompt("fix it"); // q.prompt(id, …)
await h.cancel();         // q.cancel(id)
await h.load("/ws");      // q.loadSession(id, …)
h.state();                // q.session(id)
h.toolCalls();            // ToolCallState[] (insertion order)
h.commands();             // q.commands(id)
h.subscribe(fn);          // q.subscribe(id, fn)
```

**`h.states()`** exposes the fold as an async iterable of snapshots: the
current snapshot immediately (when one exists), then the latest snapshot per
change — bursts arriving while the consumer is busy **coalesce** into one
yield of the newest state (sound because it's a fold: the latest snapshot
subsumes the missed ones). The stream is endless by design; `break`
unsubscribes:

```ts
const turn = h.prompt("go");
for await (const s of h.states()) {
  render(s);
  if (s.lastStopReason) break; // turn done
}
await turn;
```

acpq deliberately does **not** wrap the SDK's `ActiveSession` — see
[design.md](./design.md#one-canonical-route-into-the-store) for why. See
[`examples/11-attached-session.ts`](../examples/11-attached-session.ts).

### `status` — peer connectivity

`q.status` is a `StatusStore` (from agent-query-core) tracking the agent's
connectivity under the peer name given to `connect()` (`ConnectOptions.name`,
default `"agent"`). Inject a shared store via `AcpQueryConfig.status` to
aggregate acpq's peer alongside other adapters'.

Lifecycle: **`connecting`** when `connect()` is called (the SDK's `connect()`
is synchronous and performs no I/O — nothing goes over the wire until the
first request, so "connecting" is the honest state at that point);
**`ready`** after the first successful request over the connection
(`newSession()` or `prompt()` resolving — the earliest reliable signal that
the peer is actually answering); **`closed`** on `close()` *and* when the
connection dies out from under us; a reconnect walks
`connecting → ready` again.

```ts
import { AcpQuery, StatusStore } from "@johnhenry/acpq";

const status = new StatusStore(); // or share one across adapters
const q = new AcpQuery({ status });
q.connect(agent, { name: "claude-code" });
q.status.get("claude-code");                 // { state: "connecting", since, attempt }
const un = q.status.subscribe(() => render(q.status.list()));
await q.newSession();                        // → state "ready"
await q.close();                             // → state "closed"
```

**No retry on `prompt()`.** A prompt turn is non-idempotent — by the time a
request fails the agent may already have streamed text, run tools, or asked
permissions — so acpq never retries it, honoring the core's `withRetry`
contract (retries only under an explicit `idempotent: true` assertion).
Recovery is the app's call: re-prompt or start a fresh session.

### Client capabilities: `fs` / `terminal` / `gateWrites`

ACP agents can ask the *client* to read/write files and run terminals. acpq's
security default is **OFF**: no fs or terminal handler exists unless you supply
the callback in config, and nothing built-in touches a real filesystem or
spawns processes — the library only wires **your** callbacks onto the SDK's
handlers and advertises the matching capabilities.

```ts
import { AcpQuery, type AcpFsHandlers, type AcpTerminalHandlers } from "@johnhenry/acpq";

const q = new AcpQuery({
  fs: {                        // register either, both, or neither
    readTextFile: async ({ sessionId, path, line, limit }) => ({ content: "…" }),
    writeTextFile: async ({ sessionId, path, content }) => {},
  },
  terminal: {                  // all five, or nothing (the capability is all-or-nothing)
    create: async ({ sessionId, command, args, env, cwd }) => ({ terminalId: "t1" }),
    output: async ({ terminalId }) => ({ output: "…", truncated: false }),
    waitForExit: async ({ terminalId }) => ({ exitCode: 0 }),
    kill: async ({ terminalId }) => {},
    release: async ({ terminalId }) => {},
  },
  interactions: broker,
  gateWrites: true,            // gate fs writes + terminal creates through the broker
});

q.clientCapabilities();  // {fs: {readTextFile: true, writeTextFile: true}, terminal: true}
await q.initialize();    // sends `initialize` advertising exactly those capabilities
```

- **Method shapes are the SDK's own** (`ReadTextFileRequest` →
  `ReadTextFileResponse`, etc.) — params arrive schema-validated; whatever your
  callback returns goes back on the wire. Callbacks may be sync or async;
  `writeTextFile` / `release` / `kill` may return `void` (acpq answers `{}`).
- **`clientCapabilities()`** derives the `ClientCapabilities` object from
  config: per-callback `fs` flags, `terminal: true` only with the full group.
  **`initialize()`** sends it (with `PROTOCOL_VERSION`); real agents gate their
  fs/terminal usage on this, so call it before `newSession()`.
- **`gateWrites: true`** routes the write side — `fs/write_text_file` and
  `terminal/create` — through the `interactions` broker before your callback
  runs: policy first (types `"fs"` / `"terminal"`, payload
  `{method, params}`), approval inbox on `"ask"`, every outcome audited.
  Reads (`fs/read_text_file`, `terminal/output`, …) pass ungated. Denied
  gates throw a `RequestError` back to the agent and your callback never
  runs. Fail-safe: `gateWrites` with **no broker** denies all gated writes.
- Every invocation emits an `acp:fs` / `acp:terminal` devtools event (below).

See [`examples/08-client-capabilities.ts`](../examples/08-client-capabilities.ts).

### Devtools events

Pass any `DevtoolsSink` (canonically a `DevtoolsHub`) as
`AcpQueryConfig.devtools` and acpq emits compact, serializable events; with no
sink configured, emission is a no-op. The vocabulary (`AcpDevtoolsEvent`):

| `type` | Payload | Emitted |
|---|---|---|
| `acp:turn-start` | `{sessionId}` | `prompt()` called |
| `acp:turn-end` | `{sessionId, stopReason}` | `prompt()` resolved |
| `acp:update` | `{sessionId, kind, toolCallId?, status?, title?}` | per folded `session/update` (`kind` = the `sessionUpdate` discriminator; the tool-call fields appear on `tool_call`/`tool_call_update` folds) |
| `acp:permission-request` | `{sessionId, options: count}` | `session/request_permission` received |
| `acp:permission-decision` | `{sessionId, outcome: "selected" \| "cancelled", optionId?}` | the wire answer, broker-mediated or not |
| `acp:status` | `{peer, state}` | every connectivity transition |
| `acp:cancel` | `{sessionId}` | `cancel()` sent `session/cancel` |
| `acp:fs` | `{sessionId, op: "readTextFile" \| "writeTextFile", path}` | each fs handler invocation |
| `acp:terminal` | `{sessionId, op, command?, terminalId?}` | each terminal handler invocation (`op` ∈ create/output/release/waitForExit/kill) |

```ts
import { AcpQuery, DevtoolsHub, type AcpDevtoolsEvent } from "@johnhenry/acpq";

const hub = new DevtoolsHub<AcpDevtoolsEvent>();
const q = new AcpQuery({ devtools: hub });
hub.subscribe(() => console.log(hub.events().at(-1)));
// e.g. {type: "acp:update", sessionId: "sess-1", kind: "agent_message_chunk"}
```

See [`examples/07-devtools-timeline.ts`](../examples/07-devtools-timeline.ts)
for a full turn rendered as an indented timeline.

#### `instrumentAcpStream(stream, sink)` — the wire tap

For **stream transports** (ndJsonStream over stdio, WebSocket, …), wrap the
transport before `connect()` and every JSON-RPC message — requests, responses,
notifications, both directions — is emitted as a compact
`{type: "acp:wire", dir: "in" | "out", method?, id?}` event alongside the
semantic vocabulary on the same sink. `method` is present on
requests/notifications, `id` on requests/responses (a method-less event is a
response; an id-less one a notification). The tap is transparent — messages
pass through unchanged.

```ts
import { AcpQuery, DevtoolsHub, instrumentAcpStream } from "@johnhenry/acpq";
import { ndJsonStream } from "@agentclientprotocol/sdk";

const hub = new DevtoolsHub<AcpDevtoolsEvent>();
const q = new AcpQuery({ devtools: hub });
q.connect(instrumentAcpStream(ndJsonStream(stdin, stdout), hub));
```

In-process `connect(agentApp)` has no stream to tap; the semantic events still
cover it. See [`examples/09-wire-timeline.ts`](../examples/09-wire-timeline.ts)
for both strata rendered interleaved.

## `SessionState` & `ToolCallState`

```ts
interface SessionState {
  sessionId: string;
  messageText: string;                       // concatenated agent_message_chunk text
  toolCalls: Record<string, ToolCallState>;  // by toolCallId, latest status applied
  plan?: unknown;                            // latest plan entries, if reported
  availableCommands?: unknown;               // latest available_commands_update
  currentMode?: string;                      // latest current_mode_update
  lastStopReason?: string;                   // of the most recent completed turn
  updates: unknown[];                        // EVERY raw update, in arrival order
}

interface ToolCallState {
  toolCallId: string;
  title?: string;    // preserved across tool_call_update patches that omit it
  kind?: string;     // likewise
  status: string;    // "pending" | "in_progress" | "completed" | "failed" | …
  raw: unknown;      // the latest raw update for this call
}
```

Update kinds acpq doesn't fold specially (`agent_thought_chunk`,
`usage_update`, …) still land in `updates[]` — the devtools/escape hatch.
An update for a sessionId the store has never seen creates its state
implicitly (agents may stream for sessions established elsewhere, e.g.
`session/load`).

## Permissions

`session/request_permission` is answered by the configured broker; with **no
broker**, requests fail safe: the first `reject_*` option is selected, or the
request is answered `{outcome: "cancelled"}` when the agent offered no reject
option.

```ts
import { InteractionBroker, type PermissionDecision } from "@johnhenry/acpq";

const broker = new InteractionBroker<PermissionDecision>({
  policy: ({ peer, payload }) => "ask", // "allow" | "deny" | "ask" (default: ask)
});

// UI side: q.prompt(...) is blocked while an "ask" is pending —
broker.list();                                        // pending interactions (payload = wire params)
broker.resolve(id, { action: "approve", optionId: "yes" }); // human answers
broker.auditLog();                                    // every outcome, ring-buffered
```

`PermissionDecision` (what the UI resolves with, and what policies synthesize):

```ts
interface PermissionDecision extends BaseDecision {  // { action: "approve" | "deny"; reason?: string }
  optionId?: string;   // explicitly select one of the agent's offered options
  cancelled?: boolean; // answer {outcome: "cancelled"} regardless of action
}
```

Decision → wire mapping, in precedence order:

1. `cancelled: true` → `{outcome: "cancelled"}`
2. explicit `optionId` → `{outcome: "selected", optionId}`
3. `action: "approve"` → first `allow_*` option; `action: "deny"` → first `reject_*`
4. no matching option → `{outcome: "cancelled"}`

(The full policy × options table is in [design.md](./design.md#the-permission-mapping).)

`PermissionOption` mirrors the wire shape:
`{ optionId: string; name: string; kind: "allow_once" | "allow_always" | "reject_once" | "reject_always" | string }`.

## Cache keys

For apps composing on `q.cache` directly (devtools, persistence, invalidation):

```ts
import { type AcpKey, serializeAcpKey, sessionTag, sessionsTag } from "@johnhenry/acpq";

const key: AcpKey = { kind: "session", id: sid };
serializeAcpKey(key);      // '["session","sess-1"]' — the cache's canonical string key
sessionTag(sid);           // "session:sess-1" — the tag session (+ commands) entries carry
sessionsTag;               // "acp:sessions" — the tag on cached session/list entries
q.cache.getSnapshot(key);  // the full CacheEntry (version, tags, …), not just .data
```

`AcpKey` is a union: `{kind: "session", id}` (folded state),
`{kind: "session-list", cwd?}` (cached lists), `{kind: "commands", id}`
(slash-command entries).

## Re-exports from agent-query-core

For convenience, the shared engine's primitives are re-exported so most apps
need a single import: `DevtoolsHub`, `InteractionBroker`, `QueryCache`,
`StatusStore` (values) and `AuditEntry`, `BaseDecision`, `ConnectivityState`,
`DevtoolsSink`, `Interaction`, `PeerStatus`, `PolicyVerdict` (types).

## `@johnhenry/acpq/testing` — `mockAcpAgent`

An in-process ACP agent built on the SDK's own `agent()` builder — real
protocol, no transport. Drives every test and example in this repo.

```ts
import { mockAcpAgent } from "@johnhenry/acpq/testing";

q.connect(mockAcpAgent({
  name: "mock",                       // AppOptions.name for diagnostics
  onPrompt: async (ctx) => {          // behavior of each session/prompt turn
    await ctx.say("chunk of text");                       // agent_message_chunk
    await ctx.toolCall("tc1", "Read file", "pending");    // tool_call
    await ctx.toolCallUpdate("tc1", { status: "completed" }); // tool_call_update
    await ctx.update({ sessionUpdate: "current_mode_update", currentModeId: "plan" }); // any raw update
    const outcome = await ctx.askPermission([             // session/request_permission
      { optionId: "yes", name: "Allow", kind: "allow_once" },
      { optionId: "no", name: "Reject", kind: "reject_once" },
    ]);
    if (ctx.cancelled()) return "cancelled";              // client sent session/cancel?
    await ctx.whenCancelled;                              // …or await it
    return "end_turn";                                    // the stop reason (default "end_turn",
  },                                                      //  or "cancelled" when the turn was)
}));
```

`ctx.update(update, sessionId?)` accepts a sessionId override to emit for a
different session than the current turn's. `ctx.text` is the concatenated
prompt text; `ctx.sessionId` the turn's session.

`MockAcpAgentOptions.listSessions` serves `session/list` (return one page per
call; `nextCursor` drives the client's pagination loop) and
`MockAcpAgentOptions.onLoad` serves `session/load` (replay history through its
`say`/`toolCall`/`update` helpers, optionally return `{currentModeId}`) — both
registered only when supplied.

`ctx.call(method, params)` calls any client-side method
(`fs/read_text_file`, `terminal/create`, …) — the escape hatch for exercising
client capabilities from a scripted turn. `MockAcpAgentOptions.onInitialize`
observes the client's `initialize` request (e.g. to assert the advertised
`clientCapabilities`); the mock always answers `{protocolVersion: 1}`.
