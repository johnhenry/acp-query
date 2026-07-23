// instrumentAcpStream: a wire tap for stream transports. Every JSON-RPC
// message crossing the stream — both directions — lands in the devtools sink
// as a compact acp:wire event, alongside (and interleaved with) the semantic
// acp:* vocabulary from AcpQuery itself.

import { describe, it, expect } from "vitest";
import type { AnyMessage, Stream } from "@agentclientprotocol/sdk";
import {
  AcpQuery,
  DevtoolsHub,
  instrumentAcpStream,
  type AcpDevtoolsEvent,
} from "../src/index.js";
import { mockAcpAgent } from "../src/testing/mockAgent.js";

/** An in-memory duplex: two identity TransformStreams cross-wired. */
const streamPair = (): [Stream, Stream] => {
  const a = new TransformStream<AnyMessage, AnyMessage>();
  const b = new TransformStream<AnyMessage, AnyMessage>();
  return [
    { writable: a.writable, readable: b.readable },
    { writable: b.writable, readable: a.readable },
  ];
};

type Wire = Extract<AcpDevtoolsEvent, { type: "acp:wire" }>;
const wire = (hub: DevtoolsHub<AcpDevtoolsEvent>): Wire[] =>
  hub.events().filter((e): e is Wire => e.type === "acp:wire");

describe("instrumentAcpStream", () => {
  it("taps both directions of a real stream transport during a turn", async () => {
    const [clientSide, agentSide] = streamPair();
    const hub = new DevtoolsHub<AcpDevtoolsEvent>();
    const agent = mockAcpAgent({
      onPrompt: async ({ say }) => {
        await say("over the wire");
      },
    });
    agent.connect(agentSide);
    const q = new AcpQuery({ devtools: hub });
    q.connect(instrumentAcpStream(clientSide, hub), { name: "wired" });

    const sid = await q.newSession();
    await q.prompt(sid, "hi");

    const out = wire(hub).filter((e) => e.dir === "out");
    const inn = wire(hub).filter((e) => e.dir === "in");
    // Outgoing requests carry method + id…
    expect(out.map((e) => e.method)).toEqual(["session/new", "session/prompt"]);
    for (const e of out) expect(e.id).toBeDefined();
    // …incoming: the session/update notification (method, no id) and the two
    // responses (id, no method).
    expect(inn.filter((e) => e.method === "session/update")).toHaveLength(1);
    expect(inn.filter((e) => e.method === undefined && e.id !== undefined)).toHaveLength(2);
    // The tap is transparent: the turn folded normally.
    expect(q.session(sid)!.messageText).toBe("over the wire");
    await q.close();
  });

  it("interleaves acp:wire with the semantic events on the same hub", async () => {
    const [clientSide, agentSide] = streamPair();
    const hub = new DevtoolsHub<AcpDevtoolsEvent>();
    mockAcpAgent({
      onPrompt: async ({ say }) => {
        await say("x");
      },
    }).connect(agentSide);
    const q = new AcpQuery({ devtools: hub });
    q.connect(instrumentAcpStream(clientSide, hub));
    const sid = await q.newSession();
    await q.prompt(sid, "go");
    const types = hub.events().map((e) => e.type);
    // The prompt request goes on the wire after turn-start and before the
    // folded update / turn-end.
    expect(types.indexOf("acp:turn-start")).toBeLessThan(types.lastIndexOf("acp:wire"));
    expect(types).toContain("acp:update");
    expect(types).toContain("acp:wire");
    await q.close();
  });
});
