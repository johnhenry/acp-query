// 10 · Session list/load caching — the thin cacheable-read surface on an
// otherwise stream-shaped protocol: listSessions() is a cached, paginated
// read (invalidated when newSession changes membership), loadSession()
// replays a session's history into a FRESH fold (a load IS the reconcile
// read), and available slash commands live in their own cache entry for
// command palettes.
// Run: npx tsx examples/10-session-list-load.ts

import { AcpQuery } from "../src/index.js";
import { mockAcpAgent } from "../src/testing/mockAgent.js";

let listCalls = 0;
const known = [
  { sessionId: "sess-refactor", cwd: "/workspace", title: "auth refactor" },
  { sessionId: "sess-docs", cwd: "/workspace", title: "docs pass" },
];

const q = new AcpQuery({ listStaleTime: 60_000 });
q.connect(
  mockAcpAgent({
    listSessions: ({ cursor }) => {
      listCalls++;
      // Two pages of one, to show the client walking the cursor.
      return cursor ? { sessions: [known[1]!] } : { sessions: [known[0]!], nextCursor: "p2" };
    },
    onLoad: async ({ sessionId, say, toolCall, update }) => {
      await say(`(replaying ${sessionId}) I renamed AuthService and `);
      await toolCall("tc-hist", "edit src/auth.ts");
      await say("updated 12 call sites.");
      await update({
        sessionUpdate: "available_commands_update",
        availableCommands: [{ name: "diff", description: "Show the pending diff" }],
      });
      return { currentModeId: "code" };
    },
  }),
  { name: "mock-agent" },
);

console.log("--- listSessions: cached + paginated ---");
const sessions = await q.listSessions();
console.log(`fetched ${sessions.length} sessions in ${listCalls} page requests:`);
for (const s of sessions) console.log(`  ${s.sessionId}  (${s.title})`);
await q.listSessions();
console.log(`second call: still ${listCalls} page requests (cache hit)`);

console.log("\n--- loadSession: replay is the reconcile read ---");
const sid = sessions[0]!.sessionId;
const unsub = q.subscribe(sid, () => process.stdout.write("."));
const state = await q.loadSession(sid, "/workspace");
unsub();
console.log("\nreplayed text:", state.messageText);
console.log("replayed tool calls:", Object.keys(state.toolCalls).join(", "));
console.log("current mode:", state.currentMode);

console.log("\n--- commands: their own cache entry ---");
console.log("palette:", JSON.stringify(q.commands(sid)));

console.log("\n--- newSession invalidates the list ---");
await q.newSession("/workspace");
await q.listSessions();
console.log(`after newSession, listSessions refetched (now ${listCalls} page requests)`);

await q.close();
