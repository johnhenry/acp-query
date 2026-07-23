import { describe, it, expect } from "vitest";
import { AcpQuery, InteractionBroker, type PermissionDecision } from "../src/index.js";
import { mockAcpAgent } from "../src/testing/mockAgent.js";

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

describe("session store", () => {
  it("folds a prompt turn's updates into reactive session state", async () => {
    const q = new AcpQuery();
    q.connect(
      mockAcpAgent({
        onPrompt: async ({ say, toolCall }) => {
          await say("Hello, ");
          await say("world.");
          await toolCall("tc1", "read file");
        },
      }),
    );
    const sid = await q.newSession("/work");
    const versions: number[] = [];
    q.subscribe(sid, () => versions.push(1));
    const stop = await q.prompt(sid, "hi");
    expect(stop).toBe("end_turn");
    const s = q.session(sid)!;
    expect(s.messageText).toBe("Hello, world.");
    expect(s.toolCalls.tc1?.title).toBe("read file");
    expect(s.lastStopReason).toBe("end_turn");
    expect(s.updates.length).toBe(3);
    expect(versions.length).toBeGreaterThanOrEqual(3);
    await q.close();
  });
});

describe("permission broker", () => {
  it("queues the request and honors the UI's selected option", async () => {
    const broker = new InteractionBroker<PermissionDecision>();
    const outcomes: unknown[] = [];
    const q = new AcpQuery({ interactions: broker });
    q.connect(
      mockAcpAgent({
        onPrompt: async ({ say, askPermission }) => {
          const outcome = await askPermission();
          outcomes.push(outcome);
          await say(outcome.outcome === "selected" && outcome.optionId === "yes" ? "did it" : "declined");
        },
      }),
    );
    const sid = await q.newSession();
    const turn = q.prompt(sid, "do the thing");
    for (let i = 0; i < 200 && broker.list().length === 0; i++) await tick(5);
    const pending = broker.list()[0]!;
    expect(pending.type).toBe("permission");
    broker.resolve(pending.id, { action: "approve", optionId: "yes" });
    await turn;
    expect(outcomes[0]).toEqual({ outcome: "selected", optionId: "yes" });
    expect(q.session(sid)!.messageText).toBe("did it");
    expect(broker.auditLog().at(-1)?.outcome).toBe("approved");
    await q.close();
  });

  it("policy deny auto-rejects without a human prompt", async () => {
    const broker = new InteractionBroker<PermissionDecision>({ policy: () => "deny" });
    const q = new AcpQuery({ interactions: broker });
    q.connect(
      mockAcpAgent({
        onPrompt: async ({ say, askPermission }) => {
          const outcome = await askPermission();
          await say(outcome.outcome === "selected" ? `chose:${outcome.optionId}` : "cancelled");
        },
      }),
    );
    const sid = await q.newSession();
    await q.prompt(sid, "try it");
    expect(q.session(sid)!.messageText).toBe("chose:no");
    expect(broker.list()).toHaveLength(0);
    expect(broker.auditLog().at(-1)?.outcome).toBe("auto-deny");
    await q.close();
  });

  it("with no broker, permission requests fail safe (reject option chosen)", async () => {
    const q = new AcpQuery();
    q.connect(
      mockAcpAgent({
        onPrompt: async ({ say, askPermission }) => {
          const outcome = await askPermission();
          await say(outcome.outcome === "selected" ? `chose:${outcome.optionId}` : "cancelled");
        },
      }),
    );
    const sid = await q.newSession();
    await q.prompt(sid, "try it");
    expect(q.session(sid)!.messageText).toBe("chose:no");
    await q.close();
  });
});
