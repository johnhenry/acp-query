// 06 · Cancel — stop a turn mid-flight. Per the ACP spec, after
// session/cancel the client MUST answer the session's pending permission
// requests with {outcome: "cancelled"} — cancel() does that automatically —
// and the agent finishes the turn with stopReason "cancelled".
// Run: npx tsx examples/06-cancel.ts

import { AcpQuery, InteractionBroker, type PermissionDecision } from "../src/index.js";
import { mockAcpAgent } from "../src/testing/mockAgent.js";

const broker = new InteractionBroker<PermissionDecision>(); // ask policy: queue for a human
const q = new AcpQuery({ interactions: broker });

q.connect(
  mockAcpAgent({
    onPrompt: async ({ say, askPermission }) => {
      await say("About to run a migration — may I? ");
      const outcome = await askPermission(); // blocks on the human…
      await say(outcome.outcome === "cancelled" ? "Turn cancelled, standing down." : "Proceeding!");
      // Returning nothing: the mock reports stopReason "cancelled" because
      // the client cancelled this turn.
    },
  }),
  { name: "mock-coder" },
);

const sid = await q.newSession();
const turn = q.prompt(sid, "migrate the database");

while (broker.list().length === 0) await new Promise((r) => setTimeout(r, 5));
console.log("pending permission:", broker.list().length, "— user closes the tab instead of answering…");

await q.cancel(sid); // sends session/cancel AND resolves the pending permission as cancelled

const stopReason = await turn;
console.log("stopReason:", stopReason);
console.log("agent said:", q.session(sid)!.messageText);
console.log("pending after cancel:", broker.list().length);
const audit = broker.auditLog().at(-1)!;
console.log(`audit: outcome=${audit.outcome} reason=${audit.reason}`);

await q.close();
