// Devtools emission: when config.devtools is set, AcpQuery emits the compact
// AcpDevtoolsEvent vocabulary; when absent, nothing is emitted anywhere.

import { describe, it, expect } from "vitest";
import {
  AcpQuery,
  DevtoolsHub,
  InteractionBroker,
  type AcpDevtoolsEvent,
  type PermissionDecision,
} from "../src/index.js";
import { mockAcpAgent } from "../src/testing/mockAgent.js";

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const types = (hub: DevtoolsHub<AcpDevtoolsEvent>) => hub.events().map((e) => e.type);

describe("devtools emission", () => {
  it("emits turn-start, per-fold updates, turn-end (in order) for a full turn", async () => {
    const hub = new DevtoolsHub<AcpDevtoolsEvent>();
    const q = new AcpQuery({ devtools: hub });
    q.connect(
      mockAcpAgent({
        onPrompt: async ({ say, toolCall }) => {
          await say("Hello, ");
          await say("world.");
          await toolCall("tc1", "read file");
        },
      }),
      { name: "mock" },
    );
    const sid = await q.newSession();
    await q.prompt(sid, "hi");

    const turn = hub.events().filter((e) => e.type.startsWith("acp:") && e.type !== "acp:status");
    expect(turn).toEqual([
      { type: "acp:turn-start", sessionId: sid },
      { type: "acp:update", sessionId: sid, kind: "agent_message_chunk" },
      { type: "acp:update", sessionId: sid, kind: "agent_message_chunk" },
      {
        type: "acp:update",
        sessionId: sid,
        kind: "tool_call",
        toolCallId: "tc1",
        status: "completed",
        title: "read file",
      },
      { type: "acp:turn-end", sessionId: sid, stopReason: "end_turn" },
    ]);
    // Status transitions ride the same hub.
    expect(types(hub).filter((t) => t === "acp:status")).toHaveLength(2); // connecting, ready
    await q.close();
    expect(hub.events().at(-1)).toEqual({ type: "acp:status", peer: "mock", state: "closed" });
  });

  it("emits the permission request→decision pair for the broker-approved path", async () => {
    const hub = new DevtoolsHub<AcpDevtoolsEvent>();
    const broker = new InteractionBroker<PermissionDecision>(); // default: ask
    const q = new AcpQuery({ devtools: hub, interactions: broker });
    q.connect(
      mockAcpAgent({
        onPrompt: async ({ askPermission }) => {
          await askPermission();
        },
      }),
    );
    const sid = await q.newSession();
    const turn = q.prompt(sid, "do it");
    for (let i = 0; i < 200 && broker.list().length === 0; i++) await tick();

    expect(hub.events().at(-1)).toEqual({
      type: "acp:permission-request",
      sessionId: sid,
      options: 2, // the mock's default yes/no pair
    });

    broker.resolve(broker.list()[0]!.id, { action: "approve", optionId: "yes" });
    await turn;
    const decision = hub.events().find((e) => e.type === "acp:permission-decision");
    expect(decision).toEqual({
      type: "acp:permission-decision",
      sessionId: sid,
      outcome: "selected",
      optionId: "yes",
    });
    await q.close();
  });

  it("emits the pair for auto-policy decisions too (deny → reject option selected)", async () => {
    const hub = new DevtoolsHub<AcpDevtoolsEvent>();
    const broker = new InteractionBroker<PermissionDecision>({ policy: () => "deny" });
    const q = new AcpQuery({ devtools: hub, interactions: broker });
    q.connect(
      mockAcpAgent({
        onPrompt: async ({ askPermission }) => {
          await askPermission();
        },
      }),
    );
    const sid = await q.newSession();
    await q.prompt(sid, "try it");
    const perm = hub.events().filter((e) => e.type.startsWith("acp:permission"));
    expect(perm).toEqual([
      { type: "acp:permission-request", sessionId: sid, options: 2 },
      { type: "acp:permission-decision", sessionId: sid, outcome: "selected", optionId: "no" },
    ]);
    await q.close();
  });

  it("emits acp:cancel and a cancelled decision (no optionId) on the cancel path", async () => {
    const hub = new DevtoolsHub<AcpDevtoolsEvent>();
    const broker = new InteractionBroker<PermissionDecision>();
    const q = new AcpQuery({ devtools: hub, interactions: broker });
    q.connect(
      mockAcpAgent({
        onPrompt: async ({ askPermission }) => {
          await askPermission();
        },
      }),
    );
    const sid = await q.newSession();
    const turn = q.prompt(sid, "dangerous");
    for (let i = 0; i < 200 && broker.list().length === 0; i++) await tick();
    await q.cancel(sid);
    expect(await turn).toBe("cancelled");

    const tail = hub
      .events()
      .filter((e) => ["acp:cancel", "acp:permission-decision", "acp:turn-end"].includes(e.type));
    expect(tail).toEqual([
      { type: "acp:cancel", sessionId: sid },
      { type: "acp:permission-decision", sessionId: sid, outcome: "cancelled" },
      { type: "acp:turn-end", sessionId: sid, stopReason: "cancelled" },
    ]);
    await q.close();
  });

  it("no devtools config ⇒ no emission (a hub elsewhere stays empty)", async () => {
    const hub = new DevtoolsHub<AcpDevtoolsEvent>();
    const q = new AcpQuery(); // no devtools
    q.connect(
      mockAcpAgent({
        onPrompt: async ({ say }) => {
          await say("silent");
        },
      }),
    );
    const sid = await q.newSession();
    await q.prompt(sid, "hi");
    await q.close();
    expect(hub.events()).toEqual([]); // never wired, never emitted to
    expect(q.session(sid)!.messageText).toBe("silent"); // behavior unchanged
  });
});
