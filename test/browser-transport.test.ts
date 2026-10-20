// Browser transport: AcpQuery over the SDK's WebSocket and Streamable-HTTP
// streams, served by a real local companion. The client side uses only what a
// page has (globalThis.WebSocket / fetch), no Node-only APIs.

import { afterEach, describe, expect, it } from "vitest";
import { createWebSocketStream } from "@agentclientprotocol/sdk/experimental/ws-client";
import { createHttpStream } from "@agentclientprotocol/sdk/experimental/http-client";
import { AcpQuery, DevtoolsHub, InteractionBroker, instrumentAcpStream, type AcpDevtoolsEvent, type PermissionDecision } from "../src/index.js";
import { mockAcpAgent } from "../src/testing/mockAgent.js";
import { startCompanion, type Companion } from "./support/wsCompanion.js";

let companion: Companion | undefined;
afterEach(async () => {
  await companion?.close();
  companion = undefined;
});

const agent = () =>
  mockAcpAgent({
    onPrompt: async ({ text, say }) => {
      await say("you said: ");
      await say(text);
    },
  });

describe("ACP over WebSocket", () => {
  it("runs a session: newSession, prompt, streamed text folds into state", async () => {
    companion = await startCompanion(agent);
    const q = new AcpQuery();
    q.connect(createWebSocketStream(companion.wsUrl()));
    await q.initialize();
    const sid = await q.newSession("/workspace");
    const stop = await q.prompt(sid, "hello");
    expect(stop).toBe("end_turn");
    expect(q.session(sid)!.messageText).toBe("you said: hello");
    await q.close();
  });

  it("routes a permission request through the broker over the socket", async () => {
    companion = await startCompanion(() =>
      mockAcpAgent({
        onPrompt: async ({ askPermission, say }) => {
          const r = await askPermission();
          await say(r.outcome === "selected" ? `chose ${r.optionId}` : "cancelled");
        },
      }),
    );
    const broker = new InteractionBroker<PermissionDecision>();
    const q = new AcpQuery({ interactions: broker });
    q.connect(createWebSocketStream(companion.wsUrl()));
    await q.initialize();
    const sid = await q.newSession();
    const turn = q.prompt(sid, "go");
    for (let i = 0; i < 400 && broker.list().length === 0; i++) await new Promise((r) => setTimeout(r, 5));
    broker.resolve(broker.list()[0]!.id, { optionId: "yes" } as PermissionDecision);
    await turn;
    expect(q.session(sid)!.messageText).toBe("chose yes");
    await q.close();
  });

  it("composes with instrumentAcpStream (wire summaries, no bodies)", async () => {
    companion = await startCompanion(agent);
    const hub = new DevtoolsHub<AcpDevtoolsEvent>();
    const q = new AcpQuery();
    q.connect(instrumentAcpStream(createWebSocketStream(companion.wsUrl()), hub));
    await q.initialize();
    const sid = await q.newSession();
    await q.prompt(sid, "x");
    const wire = hub.events().filter((e) => e.type === "acp:wire");
    expect(wire.some((e) => (e as { method?: string }).method === "session/prompt")).toBe(true);
    expect(JSON.stringify(wire)).not.toContain("you said");
    await q.close();
  });

  it("a wrong or missing token is refused at the upgrade, never reaching the agent", async () => {
    companion = await startCompanion(agent, { token: "s3cret" });
    const q = new AcpQuery();
    q.connect(createWebSocketStream(companion.wsUrl("nope")));
    await expect(q.initialize()).rejects.toBeTruthy();
    expect(companion.rejected).toContain("token");
    await q.close().catch(() => {});

    const ok = new AcpQuery();
    ok.connect(createWebSocketStream(companion.wsUrl("s3cret")));
    await ok.initialize();
    const sid = await ok.newSession();
    expect(typeof sid).toBe("string");
    await ok.close();
  });
});

describe("ACP over Streamable HTTP", () => {
  it("runs a session with fetch only (works through proxies that block WebSocket)", async () => {
    companion = await startCompanion(agent);
    const q = new AcpQuery();
    q.connect(createHttpStream(companion.url));
    await q.initialize();
    const sid = await q.newSession("/workspace");
    await q.prompt(sid, "over http");
    expect(q.session(sid)!.messageText).toBe("you said: over http");
    await q.close();
  });
});
