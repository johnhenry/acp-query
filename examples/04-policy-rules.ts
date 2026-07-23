// 04 · Policy rules — auto-answer permissions by trust policy: no human in
// the loop. "allow" picks the FIRST allow_* option the agent offered (so an
// agent leading with allow_always gets a standing grant), "deny" the first
// reject_*; anything unmatched would fall back to "ask".
// Run: npx tsx examples/04-policy-rules.ts

import { AcpQuery, InteractionBroker, type PermissionDecision } from "../src/index.js";
import { mockAcpAgent } from "../src/testing/mockAgent.js";

// The policy sees the full wire payload {sessionId, toolCall, options} plus
// the peer label — real apps usually inspect toolCall; here we route on the
// option ids the agent offered.
const broker = new InteractionBroker<PermissionDecision>({
  policy: ({ payload }) => {
    const { options } = payload as { options: Array<{ optionId: string }> };
    if (options.some((o) => o.optionId.includes("read"))) return "allow";
    if (options.some((o) => o.optionId.includes("delete"))) return "deny";
    return "ask";
  },
});
const q = new AcpQuery({ interactions: broker });

q.connect(
  mockAcpAgent({
    onPrompt: async ({ say, askPermission }) => {
      const read = await askPermission([
        { optionId: "read-always", name: "Always allow reads", kind: "allow_always" },
        { optionId: "read-once", name: "Allow once", kind: "allow_once" },
        { optionId: "read-no", name: "Reject", kind: "reject_once" },
      ]);
      await say(`read  -> ${JSON.stringify(read)}\n`);
      const del = await askPermission([
        { optionId: "delete-yes", name: "Allow", kind: "allow_once" },
        { optionId: "delete-never", name: "Never delete", kind: "reject_always" },
      ]);
      await say(`delete-> ${JSON.stringify(del)}\n`);
    },
  }),
  { name: "mock-coder" },
);

const sid = await q.newSession();
await q.prompt(sid, "read then delete");

console.log(q.session(sid)!.messageText.trimEnd());
// read  -> selected "read-always" (first allow_* — the standing grant)
// delete-> selected "delete-never" (first reject_*)

console.log("--- audit ---");
for (const e of broker.auditLog()) console.log(`${e.outcome} (peer=${e.peer})`);
console.log("pending interactions:", broker.list().length, "(policy answered everything)");

await q.close();
