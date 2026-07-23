// AcpSessionHandle: bound-session sugar — every call delegates to AcpQuery,
// the store stays the single source of truth, and states() streams coalesced
// snapshots until the consumer breaks.

import { describe, it, expect } from "vitest";
import { AcpQuery, InteractionBroker, type PermissionDecision, type SessionState } from "../src/index.js";
import { mockAcpAgent } from "../src/testing/mockAgent.js";

describe("attach / newAttachedSession", () => {
  it("binds prompt/state/toolCalls/subscribe to one sessionId", async () => {
    const q = new AcpQuery();
    q.connect(
      mockAcpAgent({
        onPrompt: async ({ say, toolCall }) => {
          await say("bound. ");
          await toolCall("tc1", "grep", "completed");
        },
      }),
    );
    const h = await q.newAttachedSession("/workspace");
    let notified = 0;
    const unsub = h.subscribe(() => notified++);
    const stop = await h.prompt("hello");
    expect(stop).toBe("end_turn");
    expect(h.state()!.messageText).toBe("bound. ");
    expect(h.toolCalls().map((t) => t.toolCallId)).toEqual(["tc1"]);
    expect(notified).toBeGreaterThan(0);
    // Same store underneath: q's view and the handle's view are identical.
    expect(q.session(h.sessionId)).toBe(h.state());
    // A second handle on the same id sees the same state (no per-handle copies).
    expect(q.attach(h.sessionId).state()).toBe(h.state());
    unsub();
    await q.close();
  });

  it("cancel() is the bound cancel: pending permission swept, turn ends cancelled", async () => {
    const broker = new InteractionBroker<PermissionDecision>(); // ask
    const q = new AcpQuery({ interactions: broker });
    q.connect(
      mockAcpAgent({
        onPrompt: async ({ askPermission }) => {
          await askPermission();
        },
      }),
    );
    const h = await q.newAttachedSession();
    const turn = h.prompt("dangerous");
    while (broker.list().length === 0) await new Promise((r) => setTimeout(r, 5));
    await h.cancel();
    expect(await turn).toBe("cancelled");
    expect(h.state()!.lastStopReason).toBe("cancelled");
    await q.close();
  });

  it("load() replays through the handle (delegates to loadSession)", async () => {
    const q = new AcpQuery();
    q.connect(
      mockAcpAgent({
        onLoad: async ({ say }) => {
          await say("from history");
        },
      }),
    );
    const h = q.attach("sess-elsewhere"); // id from another client / listSessions()
    expect(h.state()).toBeUndefined();
    const state = await h.load("/workspace");
    expect(state.messageText).toBe("from history");
    expect(h.state()!.messageText).toBe("from history");
    await q.close();
  });
});

describe("states() async iterable", () => {
  it("streams snapshots during a turn; break unsubscribes", async () => {
    const q = new AcpQuery();
    q.connect(
      mockAcpAgent({
        onPrompt: async ({ say }) => {
          await say("a");
          await say("b");
          await say("c");
        },
      }),
    );
    const h = await q.newAttachedSession();
    const turn = h.prompt("go");
    const seen: string[] = [];
    for await (const s of h.states()) {
      seen.push(s.messageText);
      if (s.lastStopReason) break;
    }
    await turn;
    // Ends on the completed turn; the final snapshot has the full text.
    expect(seen.at(-1)).toBe("abc");
    expect(h.state()!.lastStopReason).toBe("end_turn");
    // Snapshots arrive in fold order (possibly coalesced, never reordered).
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i]!.startsWith(seen[i - 1]!.slice(0, seen[i]!.length))).toBe(true);
    }
    await q.close();
  });

  it("yields the current snapshot immediately for an already-active session", async () => {
    const q = new AcpQuery();
    q.connect(
      mockAcpAgent({
        onPrompt: async ({ say }) => {
          await say("already here");
        },
      }),
    );
    const h = await q.newAttachedSession();
    await h.prompt("go");
    const iter = h.states()[Symbol.asyncIterator]();
    const first = (await iter.next()) as IteratorResult<SessionState>;
    expect(first.done).toBe(false);
    expect((first.value as SessionState).messageText).toBe("already here");
    await iter.return?.(); // release the subscription
    await q.close();
  });

  it("coalesces bursts: a slow consumer sees the latest state, not every fold", async () => {
    const q = new AcpQuery();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    q.connect(
      mockAcpAgent({
        onPrompt: async ({ say }) => {
          // Burst of folds while the consumer is parked.
          await say("1");
          await say("2");
          await say("3");
          release();
        },
      }),
    );
    const h = await q.newAttachedSession();
    const turn = h.prompt("go");
    await gate; // all three folds have landed before we start consuming
    const seen: string[] = [];
    for await (const s of h.states()) {
      seen.push(s.messageText);
      if (s.lastStopReason) break;
    }
    await turn;
    expect(seen[0]).toBe("123"); // one coalesced snapshot, not "1","2","3"
    await q.close();
  });
});
