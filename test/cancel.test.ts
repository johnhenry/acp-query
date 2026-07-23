// The cancel contract: after session/cancel the client MUST answer that
// session's pending permission requests with {outcome: "cancelled"}, and the
// agent must finish the turn with stopReason "cancelled".

import { describe, it, expect } from "vitest";
import { AcpQuery, InteractionBroker, type PermissionDecision } from "../src/index.js";
import { mockAcpAgent } from "../src/testing/mockAgent.js";

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

describe("cancel()", () => {
  it("resolves the session's pending permission request as cancelled and surfaces stopReason", async () => {
    const broker = new InteractionBroker<PermissionDecision>();
    const q = new AcpQuery({ interactions: broker });
    let outcome: unknown;
    q.connect(
      mockAcpAgent({
        onPrompt: async ({ askPermission }) => {
          outcome = await askPermission();
          // Return nothing: the mock reports "cancelled" because the turn was.
        },
      }),
    );
    const sid = await q.newSession();
    const turn = q.prompt(sid, "dangerous thing");
    for (let i = 0; i < 200 && broker.list().length === 0; i++) await tick();
    expect(broker.list()).toHaveLength(1); // permission pending, turn blocked

    await q.cancel(sid);
    const stop = await turn;

    expect(outcome).toEqual({ outcome: "cancelled" }); // agent saw cancelled
    expect(stop).toBe("cancelled"); // stopReason surfaced from prompt()
    expect(q.session(sid)!.lastStopReason).toBe("cancelled"); // and on state
    expect(broker.list()).toHaveLength(0); // nothing left hanging
    const audit = broker.auditLog().at(-1)!;
    expect(audit.outcome).toBe("denied");
    expect(audit.reason).toBe("session/cancel");
    await q.close();
  });

  it("only resolves pending permissions for the cancelled session", async () => {
    const broker = new InteractionBroker<PermissionDecision>();
    const q = new AcpQuery({ interactions: broker });
    const outcomes: Record<string, unknown> = {};
    q.connect(
      mockAcpAgent({
        onPrompt: async ({ sessionId, askPermission, say }) => {
          const res = await askPermission();
          outcomes[sessionId] = res;
          if (res.outcome === "selected") {
            await say("approved");
            return "end_turn";
          }
        },
      }),
    );
    const s1 = await q.newSession();
    const s2 = await q.newSession();
    const t1 = q.prompt(s1, "one");
    const t2 = q.prompt(s2, "two");
    for (let i = 0; i < 200 && broker.list().length < 2; i++) await tick();

    await q.cancel(s1);
    expect(await t1).toBe("cancelled");
    expect(outcomes[s1]).toEqual({ outcome: "cancelled" });

    // Session 2's permission is still pending — approve it normally.
    expect(broker.list()).toHaveLength(1);
    broker.resolve(broker.list()[0]!.id, { action: "approve", optionId: "yes" });
    expect(await t2).toBe("end_turn");
    expect(outcomes[s2]).toEqual({ outcome: "selected", optionId: "yes" });
    expect(q.session(s2)!.messageText).toBe("approved");
    await q.close();
  });

  it("cancel with no broker (or nothing pending) is a plain session/cancel", async () => {
    const q = new AcpQuery(); // no broker
    q.connect(
      mockAcpAgent({
        onPrompt: async ({ whenCancelled, say }) => {
          await whenCancelled;
          await say("winding down");
          return "cancelled";
        },
      }),
    );
    const sid = await q.newSession();
    const turn = q.prompt(sid, "long job");
    await tick();
    await q.cancel(sid);
    expect(await turn).toBe("cancelled");
    expect(q.session(sid)!.messageText).toBe("winding down");
    await q.close();
  });

  it("mock helper: cancelled() flag flips after session/cancel", async () => {
    const q = new AcpQuery();
    const observed: boolean[] = [];
    q.connect(
      mockAcpAgent({
        onPrompt: async ({ cancelled, whenCancelled }) => {
          observed.push(cancelled());
          await whenCancelled;
          observed.push(cancelled());
        },
      }),
    );
    const sid = await q.newSession();
    const turn = q.prompt(sid, "go");
    await tick();
    await q.cancel(sid);
    expect(await turn).toBe("cancelled");
    expect(observed).toEqual([false, true]);
    await q.close();
  });
});
