// 11 · Attached session — bound-session ergonomics: newAttachedSession()
// returns an AcpSessionHandle so prompt/cancel/state/toolCalls/states() need
// no sessionId re-passing, and states() renders a live turn as an async
// iterable of coalesced snapshots. Pure sugar over the same store — a plain
// q.session(sid) sees exactly what the handle sees.
// Run: npx tsx examples/11-attached-session.ts

import { AcpQuery } from "../src/index.js";
import { mockAcpAgent } from "../src/testing/mockAgent.js";

const q = new AcpQuery();
q.connect(
  mockAcpAgent({
    onPrompt: async ({ say, toolCall, toolCallUpdate }) => {
      await say("Looking at the failing test… ");
      await toolCall("tc1", "run vitest", "in_progress");
      await toolCallUpdate("tc1", { status: "completed" });
      await say("fixed the assertion. ");
      await say("Done.");
    },
  }),
  { name: "mock-fixer" },
);

const h = await q.newAttachedSession("/workspace");
console.log(`attached to ${h.sessionId}`);

// One canonical route into the store; the handle just binds the id.
const turn = h.prompt("fix the failing test");
for await (const s of h.states()) {
  const tools = h.toolCalls().map((t) => `${t.toolCallId}:${t.status}`).join(" ") || "-";
  console.log(`  [${s.updates.length.toString().padStart(2)} updates] tools(${tools}) ${JSON.stringify(s.messageText)}`);
  if (s.lastStopReason) break;
}
console.log("stop reason:", await turn);

// The handle and the raw store are the same view.
console.log("q.session(...) === h.state():", q.session(h.sessionId) === h.state());
await q.close();
