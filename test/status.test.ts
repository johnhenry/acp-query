// Peer connectivity: AcpQuery.status is a StatusStore keyed by the connect()
// label. connecting on connect(), ready after the first successful request,
// closed on close() and when the connection dies out from under us.

import { describe, it, expect } from "vitest";
import { AcpQuery, StatusStore } from "../src/index.js";
import { mockAcpAgent } from "../src/testing/mockAgent.js";

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

describe("status store", () => {
  it("walks connecting → ready → closed across connect/newSession/close", async () => {
    const q = new AcpQuery();
    const states: string[] = [];
    q.status.subscribe(() => states.push(q.status.get("mock-agent")?.state ?? "?"));

    expect(q.status.get("mock-agent")).toBeUndefined();
    q.connect(mockAcpAgent(), { name: "mock-agent" });
    expect(q.status.get("mock-agent")?.state).toBe("connecting");

    await q.newSession(); // first successful request over the connection
    expect(q.status.get("mock-agent")?.state).toBe("ready");

    await q.close();
    expect(q.status.get("mock-agent")?.state).toBe("closed");
    expect(states).toEqual(["connecting", "ready", "closed"]);
  });

  it("uses the default peer label when connect() has no name", async () => {
    const q = new AcpQuery();
    q.connect(mockAcpAgent());
    expect(q.status.get("agent")?.state).toBe("connecting");
    await q.close();
    expect(q.status.get("agent")?.state).toBe("closed");
  });

  it("ready is set once per connection (prompt after newSession does not re-transition)", async () => {
    const q = new AcpQuery();
    q.connect(mockAcpAgent(), { name: "a" });
    await q.newSession();
    const since = q.status.get("a")!.since;
    const version = q.status.getVersion();
    const sid = await q.newSession();
    await q.prompt(sid, "hi");
    expect(q.status.get("a")!.state).toBe("ready");
    expect(q.status.get("a")!.since).toBe(since);
    expect(q.status.getVersion()).toBe(version); // no further set() calls at all
    await q.close();
  });

  it("reconnect goes back through connecting → ready", async () => {
    const q = new AcpQuery();
    q.connect(mockAcpAgent(), { name: "a" });
    const sid = await q.newSession();
    await q.close();
    expect(q.status.get("a")?.state).toBe("closed");

    q.connect(mockAcpAgent(), { name: "a" });
    expect(q.status.get("a")?.state).toBe("connecting");
    await q.prompt(sid, "hello again"); // ready via prompt() too, not just newSession()
    expect(q.status.get("a")?.state).toBe("ready");
    await q.close();
  });

  it("marks the peer closed when the connection dies out from under us", async () => {
    const q = new AcpQuery();
    const conn = q.connect(mockAcpAgent(), { name: "dying" });
    await q.newSession();
    expect(q.status.get("dying")?.state).toBe("ready");

    conn.close(); // the connection dies without q.close()
    await conn.closed.catch(() => {});
    await tick();
    expect(q.status.get("dying")?.state).toBe("closed");

    // …and a fresh connect() is allowed, walking the lifecycle again.
    q.connect(mockAcpAgent(), { name: "dying" });
    expect(q.status.get("dying")?.state).toBe("connecting");
    await q.close();
  });

  it("accepts an injected shared StatusStore", async () => {
    const shared = new StatusStore();
    shared.set("mcp:files", { state: "ready" }); // some other adapter's peer
    const q = new AcpQuery({ status: shared });
    expect(q.status).toBe(shared);

    q.connect(mockAcpAgent(), { name: "acp:coder" });
    await q.newSession();
    await q.close();

    const peers = new Map(shared.list());
    expect(peers.get("mcp:files")?.state).toBe("ready"); // untouched
    expect(peers.get("acp:coder")?.state).toBe("closed");
  });
});
