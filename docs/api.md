# API reference — every export, with an example

The complete public surface of `@johnhenry/acpq`. Conceptual background lives in
[design.md](./design.md); runnable demos in [`examples/`](../examples).

- [`AcpQuery`](#acpquery)
  - [Construction](#construction) · [`connect` / `close`](#connect--close)
  - [`newSession` / `prompt` / `cancel`](#newsession--prompt--cancel)
  - [`session` / `subscribe`](#session--subscribe-reactive-access)
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
  interactions: new InteractionBroker() // optional permission broker — see below
});
```

`AcpQueryConfig`: `{ name?: string; interactions?: InteractionBroker<PermissionDecision> }`.

Public readonly fields: `q.cache` (the `QueryCache<AcpKey>`), `q.interactions`,
`q.app` (the underlying SDK `ClientApp`, for advanced composition — e.g.
registering additional handlers before connecting).

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
import { type AcpKey, serializeAcpKey, sessionTag } from "@johnhenry/acpq";

const key: AcpKey = { kind: "session", id: sid };
serializeAcpKey(key);      // '["session","sess-1"]' — the cache's canonical string key
sessionTag(sid);           // "session:sess-1" — the tag session entries are written under
q.cache.getSnapshot(key);  // the full CacheEntry (version, tags, …), not just .data
```

## Re-exports from agent-query-core

For convenience, the shared engine's primitives are re-exported so most apps
need a single import: `InteractionBroker`, `QueryCache` (values) and
`AuditEntry`, `BaseDecision`, `Interaction`, `PolicyVerdict` (types).

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
