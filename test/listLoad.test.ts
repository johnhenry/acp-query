// The thin cacheable-read surface: session/list (cached, paginated,
// de-duped, invalidated by newSession), session/load (the reconcile read —
// replay replaces any pre-existing fold), and available commands as a
// separately-keyed cache entry.

import { describe, it, expect } from "vitest";
import { AcpQuery, sessionsTag, type AcpKey } from "../src/index.js";
import { mockAcpAgent } from "../src/testing/mockAgent.js";

describe("listSessions", () => {
  it("fetches once, then serves the cache within listStaleTime (and follows pagination)", async () => {
    let calls = 0;
    const q = new AcpQuery();
    q.connect(
      mockAcpAgent({
        listSessions: ({ cursor }) => {
          calls++;
          return cursor === "page2"
            ? { sessions: [{ sessionId: "s-b", cwd: "/b" }] }
            : { sessions: [{ sessionId: "s-a", cwd: "/a" }], nextCursor: "page2" };
        },
      }),
      { name: "mock" },
    );
    const first = await q.listSessions();
    expect(first.map((s) => s.sessionId)).toEqual(["s-a", "s-b"]); // both pages, one read
    expect(calls).toBe(2); // one request per page
    const second = await q.listSessions();
    expect(second).toBe(first); // cache hit — same array, no wire traffic
    expect(calls).toBe(2);
    expect(q.status.get("mock")?.state).toBe("ready"); // list counts as first request
    await q.close();
  });

  it("force refetches; concurrent calls share one in-flight request", async () => {
    let calls = 0;
    const q = new AcpQuery();
    q.connect(
      mockAcpAgent({
        listSessions: () => {
          calls++;
          return { sessions: [{ sessionId: `s-${calls}`, cwd: "/" }] };
        },
      }),
    );
    const [a, b] = await Promise.all([q.listSessions(), q.listSessions()]);
    expect(a).toBe(b); // de-duped
    expect(calls).toBe(1);
    const forced = await q.listSessions({ force: true });
    expect(calls).toBe(2);
    expect(forced[0]!.sessionId).toBe("s-2");
    await q.close();
  });

  it("newSession invalidates the cached list (sessionsTag)", async () => {
    let calls = 0;
    const q = new AcpQuery();
    q.connect(
      mockAcpAgent({
        listSessions: () => {
          calls++;
          return { sessions: [] };
        },
      }),
    );
    await q.listSessions();
    expect(calls).toBe(1);
    await q.newSession(); // membership changed ⇒ tag invalidated
    const key: AcpKey = { kind: "session-list" };
    expect(q.cache.getSnapshot(key)?.isStale).toBe(true);
    expect(q.cache.getSnapshot(key)?.tags.has(sessionsTag)).toBe(true);
    await q.listSessions();
    expect(calls).toBe(2); // stale ⇒ refetched
    await q.close();
  });

  it("keys per cwd filter, records errors on the entry, and rethrows", async () => {
    const q = new AcpQuery();
    q.connect(
      mockAcpAgent({
        listSessions: ({ cwd }) => {
          if (cwd === "/boom") throw new Error("list failed");
          return { sessions: [{ sessionId: `for-${cwd ?? "all"}`, cwd: cwd ?? "/" }] };
        },
      }),
    );
    const all = await q.listSessions();
    const scoped = await q.listSessions({ cwd: "/a" });
    expect(all[0]!.sessionId).toBe("for-all");
    expect(scoped[0]!.sessionId).toBe("for-/a"); // distinct entries, distinct data
    await expect(q.listSessions({ cwd: "/boom" })).rejects.toThrow();
    expect(q.cache.getSnapshot({ kind: "session-list", cwd: "/boom" })?.status).toBe("error");
    await q.close();
  });
});

describe("loadSession", () => {
  it("replays history into a FRESH state (a load IS the reconcile read)", async () => {
    const q = new AcpQuery();
    q.connect(
      mockAcpAgent({
        onLoad: async ({ say, toolCall }) => {
          await say("replayed history. ");
          await toolCall("tc-old", "past tool run");
          return { currentModeId: "architect" };
        },
      }),
    );
    const sid = "sess-restored"; // established elsewhere — this store never saw it
    const snapshots: string[] = [];
    const unsub = q.subscribe(sid, () => snapshots.push(q.session(sid)!.messageText));

    const state = await q.loadSession(sid, "/workspace");
    expect(state.messageText).toBe("replayed history. ");
    expect(state.toolCalls["tc-old"]?.status).toBe("completed");
    expect(state.currentMode).toBe("architect");
    // Subscribers watched the replay live (reset → chunks).
    expect(snapshots.length).toBeGreaterThan(0);
    unsub();
    await q.close();
  });

  it("discards pre-existing folded state before the replay", async () => {
    const q = new AcpQuery();
    q.connect(
      mockAcpAgent({
        onPrompt: async ({ say }) => {
          await say("first life");
        },
        onLoad: async ({ say }) => {
          await say("second life");
        },
      }),
    );
    const sid = await q.newSession();
    await q.prompt(sid, "hello");
    expect(q.session(sid)!.messageText).toBe("first life");
    const state = await q.loadSession(sid);
    expect(state.messageText).toBe("second life"); // not "first lifesecond life"
    expect(state.lastStopReason).toBeUndefined(); // fresh fold
    await q.close();
  });
});

describe("commands cache", () => {
  it("available_commands_update maintains a separately-keyed entry", async () => {
    const q = new AcpQuery();
    q.connect(
      mockAcpAgent({
        onPrompt: async ({ update, say }) => {
          await update({
            sessionUpdate: "available_commands_update",
            availableCommands: [
              { name: "plan", description: "Draft a plan" },
              { name: "test", description: "Run the tests" },
            ],
          });
          await say("noise the palette must not re-render on");
        },
      }),
    );
    const sid = await q.newSession();
    let commandNotifications = 0;
    const unsub = q.subscribeCommands(sid, () => commandNotifications++);
    await q.prompt(sid, "go");
    expect(q.commands(sid)).toEqual([
      { name: "plan", description: "Draft a plan" },
      { name: "test", description: "Run the tests" },
    ]);
    // The palette entry changed once — the message chunk did not touch it.
    expect(commandNotifications).toBe(1);
    // Still mirrored on the folded state.
    expect(q.session(sid)!.availableCommands).toEqual([
      { name: "plan", description: "Draft a plan" },
      { name: "test", description: "Run the tests" },
    ]);
    unsub();
    await q.close();
  });

  it("commands() is undefined before any update and updates wholesale after", async () => {
    const q = new AcpQuery();
    q.connect(
      mockAcpAgent({
        onPrompt: async ({ update }) => {
          await update({ sessionUpdate: "available_commands_update", availableCommands: [{ name: "only", description: "The only command" }] });
        },
      }),
    );
    const sid = await q.newSession();
    expect(q.commands(sid)).toBeUndefined();
    await q.prompt(sid, "go");
    expect(q.commands(sid)).toEqual([{ name: "only", description: "The only command" }]);
    await q.close();
  });
});
