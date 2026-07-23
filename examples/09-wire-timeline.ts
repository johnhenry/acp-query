// 09 · Wire timeline — run a turn over a REAL stream transport (an in-memory
// duplex here; ndJsonStream over stdio in production) wrapped with
// instrumentAcpStream, so the devtools hub shows both strata interleaved:
// acp:wire (every JSON-RPC message, both directions) and the semantic acp:*
// events (turn, folds, tool calls with id/status/title). This is the data a
// turn-timeline panel renders.
// Run: npx tsx examples/09-wire-timeline.ts

import type { AnyMessage, Stream } from "@agentclientprotocol/sdk";
import { AcpQuery, DevtoolsHub, instrumentAcpStream, type AcpDevtoolsEvent } from "../src/index.js";
import { mockAcpAgent } from "../src/testing/mockAgent.js";

// An in-memory duplex: two identity TransformStreams cross-wired.
const a = new TransformStream<AnyMessage, AnyMessage>();
const b = new TransformStream<AnyMessage, AnyMessage>();
const clientSide: Stream = { writable: a.writable, readable: b.readable };
const agentSide: Stream = { writable: b.writable, readable: a.readable };

mockAcpAgent({
  onPrompt: async ({ say, toolCall, toolCallUpdate }) => {
    await say("Refactoring… ");
    await toolCall("tc1", "edit src/auth.ts", "in_progress");
    await toolCallUpdate("tc1", { status: "completed" });
    await say("done.");
  },
}).connect(agentSide);

const hub = new DevtoolsHub<AcpDevtoolsEvent>();
const q = new AcpQuery({ devtools: hub });
q.connect(instrumentAcpStream(clientSide, hub), { name: "wired-agent" });

const sid = await q.newSession();
await q.prompt(sid, "refactor the auth module");
await q.close();

console.log("--- interleaved timeline (wire + semantic) ---");
for (const e of hub.events()) {
  switch (e.type) {
    case "acp:wire": {
      const what = e.method ?? "(response)";
      const id = e.id !== undefined ? ` #${e.id}` : "";
      console.log(`  ${e.dir === "out" ? "→" : "←"} wire  ${what}${id}`);
      break;
    }
    case "acp:update": {
      const tool = e.toolCallId ? ` ${e.toolCallId} [${e.status ?? "?"}]${e.title ? ` ${e.title}` : ""}` : "";
      console.log(`    · fold  ${e.kind}${tool}`);
      break;
    }
    case "acp:turn-start":
      console.log(`  ▶ turn ${e.sessionId}`);
      break;
    case "acp:turn-end":
      console.log(`  ■ turn ${e.sessionId} (${e.stopReason})`);
      break;
    case "acp:status":
      console.log(`${e.peer}: ${e.state}`);
      break;
    default:
      console.log(`    · ${e.type}`);
  }
}
