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

## The thin cacheable-read surface

"Not primarily a query cache" has one deliberate exception: ACP does expose a
few *addressable reads*, and for exactly those acpq behaves like its
Apollo-shaped siblings. `session/list` is a classic cacheable read — keyed
(`{kind: "session-list", cwd?}`), staleness-bounded (`listStaleTime`),
request-de-duped, and tag-invalidated (`sessionsTag`) when `newSession()`
changes membership. Pagination is followed to the end inside one read because
the cursor is a transport detail, not part of the answer.

`session/load` is the interesting hybrid: it *looks* like a read but arrives
as a stream — the agent replays history through ordinary `session/update`
notifications. The family's reconcile rule resolves the tension: **a load IS
the reconcile read.** Since the replay is by definition the complete history,
any pre-existing folded state (gappy after a disconnect, stale from an earlier
attach) is discarded before the replay folds in — reconciling by replacement,
which is the only sound option for order-dependent deltas. This also softens
the "ACP has no replay" position under Family rules below: where an agent
supports `session/load`, there *is* a full read to reconcile against, and
`loadSession()` is how acpq performs it. Where it doesn't, the gappy-state
stance stands unchanged.

`available_commands_update` gets a small dual treatment: it folds into
`SessionState.availableCommands` like any update, *and* maintains its own
cache entry (`{kind: "commands", id}`) — because its consumer (a command
palette) has a different render cadence than a transcript view, and giving it
its own key means it only re-renders when commands actually change.

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

## One canonical route into the store

The SDK ships its own streamed-prompt ergonomics: `ctx.buildSession(cwd)` →
`ActiveSession`, with `prompt()`, `nextUpdate()` (a per-session async queue of
updates + the final stop) and `readText()`. Should acpq wrap it?

Evaluated and rejected. `ActiveSession` routes `session/update` notifications
into a **private queue per wrapper** — a second consumer of the very stream
acpq's `ClientApp` handler already folds into the store. Wrapping it would
create two routes into client state (the fold *and* the queue) with two
delivery disciplines, and subtle disagreement modes: a queue drained late
shows a past the store has already left; a wrapper disposed early silently
drops updates the store still folds. One source of truth is the entire point
of a client-state layer, so the raw request path (`prompt()` →
`session/update` handler → fold) stays the **one canonical route into the
store**.

What the SDK's wrapper is actually *for* — not re-passing the sessionId, and
consuming a turn as a stream — acpq provides on top of its own store instead:
`attach(sessionId)` returns an `AcpSessionHandle` whose every method is pure
delegation (`prompt`/`cancel`/`load`/`state`/`toolCalls`/`commands`/
`subscribe` — zero logic, so handles can't drift from the store), and
`states()` is the streaming read: an async iterable of folded snapshots
rather than raw updates. Where `nextUpdate()` hands you deltas to interpret,
`states()` hands you the interpretation — and because it yields *snapshots*,
a slow consumer coalesces bursts into the latest state instead of queueing a
backlog of stale deltas (sound precisely because the fold makes each snapshot
subsume its predecessors).

## Observability: status and devtools

### Status semantics

`q.status` is the core's `StatusStore` — the gRPC channel-state model
(`idle | connecting | ready | degraded | closed`) — keyed by the `connect()`
label. acpq uses three of those states, and the transition points were chosen
from what the SDK actually does rather than what a socket-shaped mental model
suggests:

- **`connecting`** — set synchronously inside `connect()`. The SDK's
  `connect()` performs no I/O and no handshake (nothing goes over the wire
  until the first request; acpq doesn't send `initialize` itself), so a
  just-connected peer is *unverified*: "connecting" is the honest state even
  for an in-process agent.
- **`ready`** — set when the **first request over the connection resolves**
  (`session/new` or `session/prompt`). That is the earliest signal that the
  peer end is genuinely answering; anything earlier would be reporting hope,
  not observation.
- **`closed`** — set by `close()`, and *also* when the connection dies out
  from under us (the same `conn.closed` hook that re-arms `connect()`), so a
  UI badge goes red without the app having to watch the connection itself.
  A reconnect walks `connecting → ready` again under the same peer name.

**Why acpq never retries `prompt()`.** The core's retry contract (`withRetry`)
is explicit: no retries unless the caller *asserts* `idempotent: true`, because
retrying a non-idempotent call duplicates its effects. A prompt turn is the
canonical non-idempotent call — by the time the request fails, the agent may
already have streamed message chunks, executed tool calls, or consumed a
permission grant. Re-sending it would replay all of that. So acpq surfaces the
failure and leaves recovery to the app (re-prompt, or a fresh session — see
the family rule below). The same logic applies to `newSession`: it's cheap and
*could* be retried, but acpq stays uniform and leaves retry policy above the
adapter.

### Devtools event vocabulary

With a `DevtoolsSink` configured (`AcpQueryConfig.devtools`), acpq narrates
itself in compact, serializable events — no payload bodies, just enough to
render a timeline (the full raw updates are already in `SessionState.updates`):

| Event | Fields | Moment |
|---|---|---|
| `acp:status` | `peer`, `state` | every connectivity transition |
| `acp:turn-start` | `sessionId` | `prompt()` called |
| `acp:update` | `sessionId`, `kind` | each fold (`kind` = `sessionUpdate` discriminator) |
| `acp:permission-request` | `sessionId`, `options` (count) | `session/request_permission` arrives |
| `acp:permission-decision` | `sessionId`, `outcome`, `optionId?` | its wire answer (broker, policy, no-broker, or cancel-swept) |
| `acp:cancel` | `sessionId` | `session/cancel` sent |
| `acp:turn-end` | `sessionId`, `stopReason` | `prompt()` resolved |

Permission events are emitted at the wire boundary, so every path — broker
`ask`, auto policy, no-broker fail-safe, and the cancel sweep — produces the
same request/decision pair. When no sink is configured, nothing is emitted.

Tool-call folds carry `toolCallId` / `status` / `title` on the `acp:update`
event itself, so a timeline panel can render tool rows (id, latest status,
title) without re-deriving them from `SessionState.updates`.

**Two strata, one hub.** The semantic events above describe what acpq *did*;
`instrumentAcpStream` adds what the *wire* carried. It is the acpq face of
core's `instrumentTransport` idea, reshaped for the SDK's `Stream` (paired
readable/writable of JSON-RPC messages, tapped with pass-through
`TransformStream`s) rather than an `onmessage`/`send` transport object. Both
strata land on the same sink in arrival order, so a panel can interleave them
— `session/prompt` goes out, updates stream in, each one folds. In-process
`connect(agentApp)` bypasses streams entirely and therefore can't be tapped;
that's the correct trade — there is no wire, so there is nothing to lie about.

## Client capabilities: default OFF, user callbacks only

ACP inverts the usual direction for two method groups: `fs/*` and `terminal/*`
are requests the **agent** makes of the **client** — "read this file for me",
"run this command". That is server-side exec/filesystem access, and acpq's
standing rule for such surfaces is: **default OFF, explicit opt-in, nothing
built in.**

Concretely:

- With no `fs`/`terminal` config, the handlers are **never registered** — the
  agent's request fails as an unhandled method, and `clientCapabilities()`
  advertises nothing, so a spec-abiding agent won't even try.
- acpq ships **no** node-fs or child_process backend. The config accepts
  *your* callbacks (in-memory fakes in the tests and examples; `node:fs` or a
  browser shim in a real client) and does exactly two things with them: route
  the agent's schema-validated requests in, and advertise the corresponding
  capability flags in `initialize()`.
- Capability advertising is *derived*, never asserted: per-callback `fs`
  flags; `terminal: true` only when the full five-method group is supplied
  (the spec's `terminal` capability means "all `terminal/*` methods").

`gateWrites` then extends the permission-broker discipline to the capability
surface's write side: `fs/write_text_file` and `terminal/create` pass through
`interactions.gate()` (types `"fs"`/`"terminal"`) before the callback runs —
same policy hook, same approval inbox, same audit trail as
`session/request_permission`. Reads stay ungated by default because they are
the high-frequency path and the broker's audit story is about *effects*.
Denials throw a `RequestError` to the agent; `gateWrites` with no broker
denies writes outright (fail safe, matching the no-broker permission
behavior).

## Family rules

acpq's position on the cross-adapter contracts in
[agent-query-core's design.md](https://github.com/johnhenry/agent-query-core/blob/main/docs/design.md#family-rules):

**Reconcile on stream resume.** The rule: a stream is an optimization over a
full read, so after any resume the adapter must re-read and reconcile — never
assume the gap was empty. acpq's honest position: **ACP has no replay.**
Session streams cannot be resumed with history, and there is no full read to
reconcile against — `session/update` deltas are meaningful only in arrival
order and the agent never re-sends them. A reconnect therefore leaves session
state **gappy**: whatever streamed while disconnected is simply gone from the
fold. acpq does not pretend otherwise — recovery is a **fresh session or a
re-prompt**, an app-level decision, and the status store going
`closed → connecting → ready` across the reconnect is the signal that folded
states from before the gap should be treated with suspicion.

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
| Peer connectivity (`StatusStore`) + devtools event stream | **acpq** (+ agent-query-core) |
| In-process mock agent with turn helpers (`say`, `toolCall`, `askPermission`, cancel awareness) | **acpq**/testing |

acpq deliberately does *not* wrap the SDK's whole surface: `q.app` and the
`ClientConnection` returned by `connect()` are the real SDK objects, so
anything acpq hasn't modeled (modes, forks, documents) is
reachable underneath — the same "compose, don't enclose" stance as the rest of
the [agent-query family](https://github.com/johnhenry/agent-query-core).
