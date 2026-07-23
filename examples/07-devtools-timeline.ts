// 07 · Devtools timeline — wire a DevtoolsHub into AcpQuery, run a scripted
// turn (message chunks + a tool call + a permission ask answered by a simulated
// UI), then print the hub's events as an indented timeline plus the final peer
// status from q.status.
// Run: npx tsx examples/07-devtools-timeline.ts

import {
  AcpQuery,
  DevtoolsHub,
  InteractionBroker,
  type AcpDevtoolsEvent,
  type PermissionDecision,
} from "../src/index.js";
import { mockAcpAgent } from "../src/testing/mockAgent.js";

const hub = new DevtoolsHub<AcpDevtoolsEvent>();
const broker = new InteractionBroker<PermissionDecision>(); // default policy: ask

const q = new AcpQuery({ devtools: hub, interactions: broker });

q.connect(
  mockAcpAgent({
    onPrompt: async ({ say, toolCall, toolCallUpdate, askPermission }) => {
      await say("Scanning the workspace… ");
      await toolCall("tc1", "grep TODO", "in_progress");
      await toolCallUpdate("tc1", { status: "completed" });
      const outcome = await askPermission([
        { optionId: "once", name: "Allow once", kind: "allow_once" },
        { optionId: "no", name: "Reject", kind: "reject_once" },
      ]);
      await say(outcome.outcome === "selected" ? "Cleaned up 3 TODOs." : "Left everything alone.");
    },
  }),
  { name: "mock-coder" },
);

const sid = await q.newSession();
const turn = q.prompt(sid, "tidy the TODOs");

// Simulated approval UI: wait for the ask, then approve it.
while (broker.list().length === 0) await new Promise((r) => setTimeout(r, 5));
broker.resolve(broker.list()[0]!.id, { action: "approve", optionId: "once" });
await turn;
await q.close();

// ── render the hub as an indented timeline ───────────────────────────────────
const detail = (e: AcpDevtoolsEvent): string => {
  switch (e.type) {
    case "acp:status": return `peer=${e.peer} state=${e.state}`;
    case "acp:turn-start": return e.sessionId;
    case "acp:turn-end": return `${e.sessionId} stopReason=${e.stopReason}`;
    case "acp:update": return e.kind;
    case "acp:permission-request": return `${e.options} options`;
    case "acp:permission-decision": return `${e.outcome}${e.optionId ? ` optionId=${e.optionId}` : ""}`;
    case "acp:cancel": return e.sessionId;
  }
};
// Indent by nesting: status at the margin, turns one level in, everything
// that happens inside the turn two levels in.
let inTurn = false;
console.log("--- devtools timeline ---");
for (const e of hub.events()) {
  const level =
    e.type === "acp:status" ? 0
    : e.type === "acp:turn-start" || e.type === "acp:turn-end" ? 1
    : inTurn ? 2 : 1;
  console.log(`${"  ".repeat(level)}${e.type.padEnd(26)} ${detail(e)}`);
  if (e.type === "acp:turn-start") inTurn = true;
  if (e.type === "acp:turn-end") inTurn = false;
}

console.log("--- final peer status ---");
for (const [peer, s] of q.status.list()) {
  console.log(`${peer}: ${s.state} (since ${new Date(s.since).toISOString()})`);
}
console.log("agent said:", q.session(sid)!.messageText);
