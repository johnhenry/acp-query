# Examples — granular → complex

A progression: each step adds one capability. Every example is **runnable** with no
network and no transport — the agent side is the in-process `mockAcpAgent` from
`@johnhenry/acpq/testing`, connected straight to `AcpQuery` over the SDK's real
protocol routing. Run any with `npx tsx examples/<file>` (or `npm run example:NN`).

| # | File | Adds | Run |
|---|------|------|-----|
| 01 | [`01-basic-turn.ts`](./01-basic-turn.ts) | connect → prompt → streaming state snapshots + final text | `npm run example:01` |
| 02 | [`02-tool-calls.ts`](./02-tool-calls.ts) | tool_call → tool_call_update lifecycle, rendered live | `npm run example:02` |
| 03 | [`03-permission-inbox.ts`](./03-permission-inbox.ts) | "ask" policy → approval inbox → simulated human → audit | `npm run example:03` |
| 04 | [`04-policy-rules.ts`](./04-policy-rules.ts) | trust-policy auto-answers (allow_always grants, auto-deny) | `npm run example:04` |
| 05 | [`05-multi-session.ts`](./05-multi-session.ts) | two sessions, concurrent turns, isolated folded states | `npm run example:05` |
| 06 | [`06-cancel.ts`](./06-cancel.ts) | cancel mid-turn: pending permission resolved cancelled, stopReason "cancelled" | `npm run example:06` |
| 07 | [`07-devtools-timeline.ts`](./07-devtools-timeline.ts) | DevtoolsHub events rendered as an indented turn timeline | `npm run example:07` |
| 08 | [`08-client-capabilities.ts`](./08-client-capabilities.ts) | fs + terminal callbacks, capability advertising, gated writes | `npm run example:08` |
| 09 | [`09-wire-timeline.ts`](./09-wire-timeline.ts) | instrumentAcpStream: wire messages + semantic events, one interleaved timeline | `npm run example:09` |

To point any of these at a **real** agent, replace the `mockAcpAgent(...)` argument
with a transport stream (`ndJsonStream` over a spawned agent's stdio, a WebSocket, …)
— everything else is identical; that's the point.
