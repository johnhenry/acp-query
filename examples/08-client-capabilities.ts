// 08 · Client capabilities — supply fs + terminal callbacks (in-memory fakes
// here; node:fs / child_process in a real client), advertise them via
// initialize(), and gate the WRITE side (fs write, terminal create) through
// the InteractionBroker with gateWrites. Reads pass ungated; a deny policy
// blocks the callback before it runs, and every gate outcome is audited.
// Run: npx tsx examples/08-client-capabilities.ts

import {
  AcpQuery,
  InteractionBroker,
  type AcpFsHandlers,
  type AcpTerminalHandlers,
  type PermissionDecision,
} from "../src/index.js";
import { mockAcpAgent } from "../src/testing/mockAgent.js";

// ── in-memory backends: acp-query itself never touches fs or spawns anything ─────
const files: Record<string, string> = { "/workspace/README.md": "# demo\nhello from the fake fs\n" };
const fs: AcpFsHandlers = {
  readTextFile: ({ path }) => {
    if (!(path in files)) throw new Error(`ENOENT: ${path}`);
    return { content: files[path]! };
  },
  writeTextFile: ({ path, content }) => {
    files[path] = content;
  },
};
let termSeq = 0;
const terminal: AcpTerminalHandlers = {
  create: ({ command, args }) => {
    console.log(`  [terminal] create: ${command} ${(args ?? []).join(" ")}`);
    return { terminalId: `term-${++termSeq}` };
  },
  output: () => ({ output: "3 files, 120 lines", truncated: false }),
  waitForExit: () => ({ exitCode: 0 }),
  kill: () => {},
  release: () => {},
};

// Policy: allow terminal creates, ask a human for fs writes.
const broker = new InteractionBroker<PermissionDecision>({
  policy: ({ type }) => (type === "terminal" ? "allow" : "ask"),
});

const q = new AcpQuery({ fs, terminal, interactions: broker, gateWrites: true });
console.log("advertised capabilities:", JSON.stringify(q.clientCapabilities()));

q.connect(
  mockAcpAgent({
    onPrompt: async ({ sessionId, say, call }) => {
      const readme = (await call("fs/read_text_file", { sessionId, path: "/workspace/README.md" })) as {
        content: string;
      };
      await say(`Read README (${readme.content.length} chars). `);
      const { terminalId } = (await call("terminal/create", {
        sessionId,
        command: "wc",
        args: ["-l"],
      })) as { terminalId: string };
      const out = (await call("terminal/output", { sessionId, terminalId })) as { output: string };
      await call("terminal/release", { sessionId, terminalId });
      await say(`Ran wc: ${out.output}. `);
      await call("fs/write_text_file", {
        sessionId,
        path: "/workspace/SUMMARY.md",
        content: `stats: ${out.output}\n`,
      });
      await say("Wrote SUMMARY.md.");
    },
  }),
  { name: "mock-coder" },
);

await q.initialize(); // advertises the capabilities above
const sid = await q.newSession("/workspace");
const turn = q.prompt(sid, "summarize the workspace");

// Simulated approval UI: the fs write hits the "ask" policy and queues here.
while (broker.list().length === 0) await new Promise((r) => setTimeout(r, 5));
const ask = broker.list()[0]!;
console.log(`  [inbox] ${ask.type} request from ${ask.peer}:`, (ask.payload as { method: string }).method);
broker.resolve(ask.id, { action: "approve" });
await turn;
await q.close();

console.log("agent said:", q.session(sid)!.messageText);
console.log("SUMMARY.md:", JSON.stringify(files["/workspace/SUMMARY.md"]));
console.log("--- audit trail ---");
for (const e of broker.auditLog()) console.log(`  ${e.type} → ${e.outcome}`);
