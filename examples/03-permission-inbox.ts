// 03 · Permission inbox — the "ask" policy queues session/request_permission
// for a human; a simulated UI approves it; the audit trail records everything.
// Run: npx tsx examples/03-permission-inbox.ts

import { AcpQuery, InteractionBroker, type PermissionDecision } from "../src/index.js";
import { mockAcpAgent } from "../src/testing/mockAgent.js";

const broker = new InteractionBroker<PermissionDecision>(); // default policy: ask
const q = new AcpQuery({ interactions: broker });

q.connect(
  mockAcpAgent({
    onPrompt: async ({ say, askPermission }) => {
      await say("I need to delete a file. Asking first. ");
      const outcome = await askPermission([
        { optionId: "once", name: "Allow once", kind: "allow_once" },
        { optionId: "always", name: "Always allow", kind: "allow_always" },
        { optionId: "no", name: "Reject", kind: "reject_once" },
      ]);
      await say(outcome.outcome === "selected" ? `You chose "${outcome.optionId}". Deleted.` : "Fine, I won't.");
    },
  }),
  { name: "mock-coder" }, // the broker's `peer` label
);

const sid = await q.newSession();
const turn = q.prompt(sid, "clean up temp files");

// The prompt turn is now BLOCKED on the permission. Poll the inbox like a UI would
// (broker.subscribe() gives you push notification of inbox changes).
while (broker.list().length === 0) await new Promise((r) => setTimeout(r, 5));

const pending = broker.list()[0]!;
const payload = pending.payload as { toolCall?: { title?: string }; options: Array<{ name: string }> };
console.log(`inbox: #${pending.id} from ${pending.peer}: ${payload.toolCall?.title}`);
console.log("       options:", payload.options.map((o) => o.name).join(" / "));

// Simulated human: pick an explicit option (optionId always wins the mapping).
broker.resolve(pending.id, { action: "approve", optionId: "once" });

await turn;
console.log("agent said:", q.session(sid)!.messageText);

console.log("--- audit trail ---");
for (const e of broker.auditLog()) {
  console.log(`${new Date(e.at).toISOString()} peer=${e.peer} type=${e.type} outcome=${e.outcome}`);
}

await q.close();
