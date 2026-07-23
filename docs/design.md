# Why acpq looks the way it does

The conceptual analysis behind `@johnhenry/acpq`: what a reactive client-state
library for the [Agent Client Protocol](https://agentclientprotocol.com) should
be, and why it is a **turn store**, not a query cache.

The audience is apps that *embed* an agent: web UIs, notebooks, dashboards,
editors. They all need the same thing — a rendering-ready, subscribable view of
"what is the agent doing right now in this session" plus a governed answer to
"the agent is asking to do something sensitive."

## ACP is a stream-fold, not a cache

Its siblings ([`@johnhenry/mcpq`](https://github.com/johnhenry/mcp-query) for
MCP) are Apollo-shaped: the protocol surface is *addressable reads* (resources,
tools lists) that you cache, invalidate, and refetch. ACP is not that. ACP's
center of gravity is the **prompt turn**: you send `session/prompt`, and until
it resolves the agent streams `session/update` notifications — message chunks,
tool-call lifecycles, plan revisions, mode changes. There is nothing to
"refetch": the updates are deltas, meaningful only in arrival order, and the
server never re-sends them.

So the right client-state primitive is a **fold** (in the functional sense):

```
SessionState_n+1 = fold(SessionState_n, update)
```

acpq keeps one folded `SessionState` per session in a `QueryCache` from
`@johnhenry/agent-query-core` — but the cache is used purely as a *reactive
store* (keyed snapshots + versioned subscriptions + tags + devtools), not for
staleness: session entries are written with `staleTime: Infinity` because a
stream-driven state is never "stale by age". What the cache buys is the exact
`getSnapshot`/`subscribe` pair `useSyncExternalStore` wants, shared machinery
with the rest of the agent-query family, and tag-based composition
(`sessionTag(id)`) for anything built on top.

Two invariants make the fold sound:

- **Never mutate a stored snapshot.** Every fold clones the previous state
  (`ensureState`), applies the delta, and writes the new object. Mutating in
  place would make the next write structurally equal to the stored value and
  suppress the change emission — subscribers would sleep through updates.
- **No awaits between read and write.** Each read-modify-write (folds, and
  `prompt()` recording the stop reason) is synchronous, so two writers can
  never interleave and clobber each other — even when a fold lands in the same
  microtask window as the prompt response.

## The fold vocabulary

| `sessionUpdate` kind | Folded into |
|---|---|
| `agent_message_chunk` (text) | `messageText` (concatenated) |
| `tool_call` / `tool_call_update` | `toolCalls[toolCallId]` — latest `status`, with `title`/`kind` **preserved** across patches that omit them |
| `plan` | `plan` (the entries; replaced wholesale, per spec) |
| `available_commands_update` | `availableCommands` |
| `current_mode_update` | `currentMode` |
| anything else (`agent_thought_chunk`, `usage_update`, …) | — |
| **every** update, folded or not | `updates[]`, in arrival order |

`updates[]` is the escape hatch and the devtools timeline: nothing is dropped,
so an app can render thought streams or token usage today without waiting for
acpq to grow a field. `lastStopReason` records how the most recent turn ended.

An update for a sessionId the store has never seen creates its state
implicitly — agents may stream for sessions established elsewhere (e.g.
`session/load` by another client of the same agent). Implicit states are
indistinguishable from `newSession()` ones.

## The permission mapping

`session/request_permission` is ACP's most distinctive primitive: the agent
*blocks its turn* mid-flight, offering typed options
(`allow_once` / `allow_always` / `reject_once` / `reject_always`), and the
client must pick one — or answer `cancelled`. acpq routes this through the
shared `InteractionBroker`: a trust policy runs first (`allow` / `deny` /
`ask`); `ask` queues the request for a human approval inbox; every outcome is
audited.

The full mapping, policy × decision × offered options → wire outcome:

| Source | Decision | Agent offered | Wire outcome |
|---|---|---|---|
| any | `cancelled: true` | anything | `{outcome: "cancelled"}` |
| UI (`resolve`) | explicit `optionId` | that option | `{outcome: "selected", optionId}` (wins over `action`) |
| policy `allow` / UI approve | `action: "approve"` | ≥1 `allow_*` | first `allow_*` — so an agent leading with `allow_always` gets a standing grant |
| policy `allow` / UI approve | `action: "approve"` | no `allow_*` | `{outcome: "cancelled"}` |
| policy `deny` / UI deny | `action: "deny"` | ≥1 `reject_*` | first `reject_*` |
| policy `deny` / UI deny | `action: "deny"` | no `reject_*` | `{outcome: "cancelled"}` |
| **no broker configured** | — | ≥1 `reject_*` | first `reject_*` (fail safe) |
| **no broker configured** | — | no `reject_*` | `{outcome: "cancelled"}` |

"First matching option" is deliberate: the agent orders its options, and the
spec's `kind` taxonomy makes the first `allow_*`/`reject_*` the agent's
preferred grant/refusal. A UI wanting a different one selects it explicitly by
`optionId`.

## The cancel contract

Per the ACP spec, when the client sends `session/cancel` it **must** respond to
that session's still-pending `session/request_permission` requests with
`{outcome: "cancelled"}` — otherwise the agent's turn can never finish and
`session/prompt` never resolves with its final `stopReason: "cancelled"`.

`cancel(sessionId)` therefore does both halves: it sends the notification,
then sweeps the broker's pending interactions of type `"permission"` for that
session and resolves each with the `cancelled` marker decision
(`{action: "deny", cancelled: true, reason: "session/cancel"}`) — audited as
`denied` with reason `session/cancel`. Pending permissions for *other*
sessions are untouched. The `cancelled` field on `PermissionDecision` exists
precisely so this path is expressible through the broker's ordinary resolve
machinery (and so a UI can offer a "dismiss" affordance with the same
semantics).

## What the SDK provides vs what acpq adds

| Layer | Provided by |
|---|---|
| Wire protocol, JSON-RPC framing, schema validation | `@agentclientprotocol/sdk` |
| Fluent `client()` / `agent()` builders, typed method handlers | SDK |
| Transports (stdio ndJson, WebSocket, …) and in-process `connect(app)` | SDK |
| Per-session **folded turn state**, subscribable snapshots | **acpq** |
| Connection lifecycle discipline (single connection, awaited close) | **acpq** |
| Permission **policy / inbox / audit** via `InteractionBroker` | **acpq** (+ agent-query-core) |
| The cancel contract (auto-resolving pending permissions) | **acpq** |
| In-process mock agent with turn helpers (`say`, `toolCall`, `askPermission`, cancel awareness) | **acpq**/testing |

acpq deliberately does *not* wrap the SDK's whole surface: `q.app` and the
`ClientConnection` returned by `connect()` are the real SDK objects, so
anything acpq hasn't modeled (fs/terminal handlers, `session/load`, modes) is
reachable underneath — the same "compose, don't enclose" stance as the rest of
the [agent-query family](https://github.com/johnhenry/agent-query-core).
