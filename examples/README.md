# acp-query examples

Granular → complex: each step adds one capability. Every example is **runnable** with no
network and no transport — the agent side is the in-process `mockAcpAgent` from
`@johnhenry/acp-query/testing`, connected straight to `AcpQuery` over the SDK's real
protocol routing. Run any with `npx tsx examples/<file>` (or `npm run example:NN`).

| # | File | Demonstrates | Run |
|---|------|------|-----|
| 01 | [`01-basic-turn.ts`](./01-basic-turn.ts) | `connect()` → `prompt()` folds streaming updates into live state snapshots, ending in the final text | `npm run example:01` |
| 02 | [`02-tool-calls.ts`](./02-tool-calls.ts) | `tool_call`/`tool_call_update` deltas fold into a per-call status that updates live as the agent works | `npm run example:02` |
| 03 | [`03-permission-inbox.ts`](./03-permission-inbox.ts) | an "ask" policy queues the request in the broker's approval inbox until a simulated human resolves it, and the decision is audited | `npm run example:03` |
| 04 | [`04-policy-rules.ts`](./04-policy-rules.ts) | trust-policy auto-answers requests without a human — `allow_always` grants standing approval, `deny` auto-rejects | `npm run example:04` |
| 05 | [`05-multi-session.ts`](./05-multi-session.ts) | two sessions run concurrent turns with fully isolated folded state — one session's updates never bleed into another's | `npm run example:05` |
| 06 | [`06-cancel.ts`](./06-cancel.ts) | `cancel(sessionId)` resolves that session's pending permission request as `cancelled` and the turn ends with `stopReason: "cancelled"` instead of hanging | `npm run example:06` |
| 07 | [`07-devtools-timeline.ts`](./07-devtools-timeline.ts) | `DevtoolsHub` events render as an indented turn timeline, without re-deriving state from raw updates | `npm run example:07` |
| 08 | [`08-client-capabilities.ts`](./08-client-capabilities.ts) | `fs`/`terminal` callbacks are advertised only when supplied, and `gateWrites` routes write requests through the broker before the callback runs | `npm run example:08` |
| 09 | [`09-wire-timeline.ts`](./09-wire-timeline.ts) | `instrumentAcpStream` interleaves raw wire messages with the semantic event stream in arrival order | `npm run example:09` |
| 10 | [`10-session-list-load.ts`](./10-session-list-load.ts) | `session/list` is cached and staleness-bounded; `session/load` discards stale folded state and reconciles by replaying the full history | `npm run example:10` |
| 11 | [`11-attached-session.ts`](./11-attached-session.ts) | `AcpSessionHandle` binds `prompt`/`cancel`/`state` to one session, and `states()` yields an async iterable of folded snapshots | `npm run example:11` |

To point any of these at a **real** agent, replace the `mockAcpAgent(...)` argument
with a transport stream (`ndJsonStream` over a spawned agent's stdio, a WebSocket, …)
— everything else is identical; that's the point.
