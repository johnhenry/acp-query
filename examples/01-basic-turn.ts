// 01 · Basic turn — connect, prompt, watch the session state stream in.
// Run: npx tsx examples/01-basic-turn.ts   (in-process mock agent — no transport)

import { AcpQuery } from "../src/index.js";
import { mockAcpAgent } from "../src/testing/mockAgent.js";

const q = new AcpQuery();
q.connect(
  mockAcpAgent({
    onPrompt: async ({ text, say }) => {
      await say("Thinking about ");
      await say(`"${text}"… `);
      await say("done: it's a fine idea.");
    },
  }),
);

const sid = await q.newSession("/workspace");

// subscribe() fires on every fold — this is exactly what a UI renders from.
q.subscribe(sid, () => {
  const s = q.session(sid)!;
  console.log(`[snapshot] messageText=${JSON.stringify(s.messageText)} updates=${s.updates.length}`);
});

const stopReason = await q.prompt(sid, "should we refactor auth?");

const final = q.session(sid)!;
console.log("---");
console.log("final text:", final.messageText);
console.log("stopReason:", stopReason, "(also on state:", final.lastStopReason + ")");

await q.close();
