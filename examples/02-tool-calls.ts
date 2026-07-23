// 02 · Tool calls — the tool_call → tool_call_update lifecycle, rendered live.
// Run: npx tsx examples/02-tool-calls.ts

import { AcpQuery } from "../src/index.js";
import { mockAcpAgent } from "../src/testing/mockAgent.js";

const q = new AcpQuery();
q.connect(
  mockAcpAgent({
    onPrompt: async ({ say, toolCall, toolCallUpdate }) => {
      await say("Let me look at that file. ");
      await toolCall("tc-read", "Read src/auth.ts", "pending");
      await toolCallUpdate("tc-read", { status: "in_progress" });
      await toolCallUpdate("tc-read", { status: "completed" });
      await toolCall("tc-edit", "Edit src/auth.ts", "pending");
      await toolCallUpdate("tc-edit", { status: "in_progress" });
      await toolCallUpdate("tc-edit", { status: "failed" });
      await say("The read worked, the edit did not.");
    },
  }),
);

const sid = await q.newSession();

// Render the tool-call table on every change — titles persist across
// tool_call_update patches that only carry a status.
q.subscribe(sid, () => {
  const s = q.session(sid)!;
  const row = Object.values(s.toolCalls)
    .map((t) => `${t.toolCallId}[${t.title}]=${t.status}`)
    .join("  ");
  if (row) console.log("tools:", row);
});

await q.prompt(sid, "fix the auth bug");

console.log("---");
for (const t of Object.values(q.session(sid)!.toolCalls)) {
  const icon = t.status === "completed" ? "ok " : t.status === "failed" ? "ERR" : "…  ";
  console.log(`${icon} ${t.title} (${t.toolCallId})`);
}

await q.close();
