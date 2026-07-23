// Session/connection lifecycle: multi-session isolation, the prompt()
// read-modify-write vs concurrent folds, connect/close discipline.

import { describe, it, expect } from "vitest";
import { AcpQuery } from "../src/index.js";
import { mockAcpAgent } from "../src/testing/mockAgent.js";

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

describe("multi-session isolation", () => {
  it("two sessions with interleaved prompts keep fully isolated states", async () => {
    const q = new AcpQuery();
    q.connect(
      mockAcpAgent({
        onPrompt: async ({ text, say, toolCall }) => {
          // Interleave across turns: chunk, yield, chunk.
          await say(`${text}-a`);
          await tick();
          await say(`${text}-b`);
          await toolCall(`tc-${text}`, `tool for ${text}`);
        },
      }),
    );
    const s1 = await q.newSession("/one");
    const s2 = await q.newSession("/two");
    expect(s1).not.toBe(s2);

    const [r1, r2] = await Promise.all([q.prompt(s1, "alpha"), q.prompt(s2, "beta")]);
    expect(r1).toBe("end_turn");
    expect(r2).toBe("end_turn");

    const st1 = q.session(s1)!;
    const st2 = q.session(s2)!;
    expect(st1.messageText).toBe("alpha-a" + "alpha-b");
    expect(st2.messageText).toBe("beta-a" + "beta-b");
    expect(Object.keys(st1.toolCalls)).toEqual(["tc-alpha"]);
    expect(Object.keys(st2.toolCalls)).toEqual(["tc-beta"]);
    expect(st1.updates).toHaveLength(3);
    expect(st2.updates).toHaveLength(3);
    await q.close();
  });
});

describe("prompt() write vs concurrent folds (lost-update regression)", () => {
  it("a fold landing in the same microtask window as the prompt response is not clobbered", async () => {
    const q = new AcpQuery();
    q.connect(
      mockAcpAgent({
        onPrompt: async ({ say }) => {
          await say("early");
          // Fire-and-forget: this notification races the prompt response
          // through the same microtask window.
          void say("-late");
        },
      }),
    );
    const sid = await q.newSession();
    const stop = await q.prompt(sid, "race");
    expect(stop).toBe("end_turn");
    await tick(20); // let the straggler land
    const s = q.session(sid)!;
    // Neither direction clobbered the other: the late fold survived…
    expect(s.messageText).toBe("early-late");
    // …and the fold (re-reading latest state) preserved the stop reason.
    expect(s.lastStopReason).toBe("end_turn");
    await q.close();
  });
});

describe("connect/close lifecycle", () => {
  it("newSession makes the state observable immediately", async () => {
    const q = new AcpQuery();
    q.connect(mockAcpAgent());
    const sid = await q.newSession();
    expect(q.session(sid)).toMatchObject({ sessionId: sid, messageText: "", updates: [] });
    await q.close();
  });

  it("connect() while already connected throws", async () => {
    const q = new AcpQuery();
    q.connect(mockAcpAgent());
    expect(() => q.connect(mockAcpAgent())).toThrowError(/already connected/);
    await q.close();
  });

  it("close() waits for shutdown and allows a fresh connect()", async () => {
    const q = new AcpQuery();
    const conn = q.connect(mockAcpAgent());
    const sid = await q.newSession();
    await q.close();
    await conn.closed; // close() already awaited this — must be settled
    await expect(q.prompt(sid, "hi")).rejects.toThrowError(/connect\(\) first/);

    // Reconnect to a different agent; the store (and its states) survive.
    q.connect(
      mockAcpAgent({
        onPrompt: async ({ say }) => {
          await say("second life");
        },
      }),
    );
    const sid2 = await q.newSession();
    await q.prompt(sid2, "hi again");
    expect(q.session(sid2)!.messageText).toBe("second life");
    expect(q.session(sid)).toBeDefined(); // old session state retained
    await q.close();
  });

  it("close() is idempotent and safe when never connected", async () => {
    const q = new AcpQuery();
    await q.close();
    q.connect(mockAcpAgent());
    await q.close();
    await q.close();
  });

  it("requests before connect() fail with a clear error", async () => {
    const q = new AcpQuery();
    await expect(q.newSession()).rejects.toThrowError(/connect\(\) first/);
  });
});
