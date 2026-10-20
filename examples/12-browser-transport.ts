// 12 · Browser transport — a session over a real WebSocket, using only what a
// page has: globalThis.WebSocket via the SDK's createWebSocketStream. The
// "companion" is the host-side process that serves the agent on a socket (here
// the mock agent; for a stdio agent you'd bridge its ndJsonStream instead).
// Browser WebSockets can't set headers, so the token travels in the URL and the
// companion checks it (and the Origin) at the upgrade.
// Run: npm run example:12   (binds 127.0.0.1 on an ephemeral port)

import { AcpQuery } from "../src/index.js";
import { mockAcpAgent } from "../src/testing/mockAgent.js";
import { startCompanion } from "../test/support/wsCompanion.js";
import { createWebSocketStream } from "@agentclientprotocol/sdk/experimental/ws-client";

const companion = await startCompanion(
  () => mockAcpAgent({ onPrompt: async ({ text, say }) => say(`remote agent heard: ${text}`) }),
  { token: "demo-token" },
);

const q = new AcpQuery();
q.connect(createWebSocketStream(companion.wsUrl("demo-token")), { name: "remote" });
await q.initialize(); // the transport requires `initialize` as the FIRST message
const sid = await q.newSession("/workspace");
const stop = await q.prompt(sid, "hello over a socket");
console.log("stopReason:", stop);
console.log("text:", q.session(sid)!.messageText);
await q.close();
await companion.close();
