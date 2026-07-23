// 05 · Multi-session — two sessions on one connection, prompts in flight at
// the same time, updates interleaving on the wire: each session's folded
// state stays fully isolated.
// Run: npx tsx examples/05-multi-session.ts

import { AcpQuery } from "../src/index.js";
import { mockAcpAgent } from "../src/testing/mockAgent.js";

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

const q = new AcpQuery();
q.connect(
  mockAcpAgent({
    onPrompt: async ({ text, say, toolCall }) => {
      // Chunk / yield / chunk — so two concurrent turns interleave.
      await say(`[${text}] part one. `);
      await tick(5);
      await toolCall(`tc-${text}`, `tool for ${text}`);
      await tick(5);
      await say(`[${text}] part two.`);
    },
  }),
);

const frontend = await q.newSession("/app/frontend");
const backend = await q.newSession("/app/backend");

for (const sid of [frontend, backend]) {
  q.subscribe(sid, () => {
    const s = q.session(sid)!;
    console.log(`  ${sid}: ${s.updates.length} updates, text=${JSON.stringify(s.messageText)}`);
  });
}

console.log("prompting both sessions concurrently…");
const [stopA, stopB] = await Promise.all([
  q.prompt(frontend, "restyle the navbar"),
  q.prompt(backend, "add rate limiting"),
]);

console.log("---");
const a = q.session(frontend)!;
const b = q.session(backend)!;
console.log(`frontend (${stopA}):`, a.messageText, "| tools:", Object.keys(a.toolCalls).join(","));
console.log(`backend  (${stopB}):`, b.messageText, "| tools:", Object.keys(b.toolCalls).join(","));

await q.close();
