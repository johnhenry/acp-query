// Client capabilities: fs read/write + terminal handlers.
//
// Security default: handlers exist ONLY for callbacks the caller supplies —
// nothing built-in touches a real filesystem or spawns processes. Capability
// advertising (initialize) is derived from the same config. gateWrites routes
// WRITE operations (fs write, terminal create) through the InteractionBroker.

import { describe, it, expect } from "vitest";
import {
  AcpQuery,
  DevtoolsHub,
  InteractionBroker,
  type AcpDevtoolsEvent,
  type AcpFsHandlers,
  type AcpTerminalHandlers,
  type PermissionDecision,
} from "../src/index.js";
import { mockAcpAgent } from "../src/testing/mockAgent.js";

// In-memory fakes — no real fs, no real processes.
const memFs = (files: Record<string, string> = {}): { files: Record<string, string>; fs: AcpFsHandlers } => ({
  files,
  fs: {
    readTextFile: (p) => {
      const content = files[p.path];
      if (content === undefined) throw new Error(`ENOENT: ${p.path}`);
      return { content };
    },
    writeTextFile: (p) => {
      files[p.path] = p.content;
    },
  },
});

const memTerminal = (log: string[] = []): AcpTerminalHandlers => {
  let seq = 0;
  return {
    create: (p) => {
      log.push(`create ${p.command}`);
      return { terminalId: `term-${++seq}` };
    },
    output: (p) => {
      log.push(`output ${p.terminalId}`);
      return { output: "fake output", truncated: false };
    },
    release: (p) => {
      log.push(`release ${p.terminalId}`);
    },
    waitForExit: (p) => {
      log.push(`waitForExit ${p.terminalId}`);
      return { exitCode: 0 };
    },
    kill: (p) => {
      log.push(`kill ${p.terminalId}`);
    },
  };
};

describe("capability advertising", () => {
  it("advertises {} with no fs/terminal config, and never registers handlers", async () => {
    const q = new AcpQuery();
    expect(q.clientCapabilities()).toEqual({});
    let failed: unknown;
    q.connect(
      mockAcpAgent({
        onPrompt: async ({ call }) => {
          // No fs config ⇒ the method is unhandled on the client.
          await call("fs/read_text_file", { sessionId: "s", path: "/x" }).catch((e) => (failed = e));
        },
      }),
    );
    const sid = await q.newSession();
    await q.prompt(sid, "try to read");
    expect(failed).toBeTruthy();
    await q.close();
  });

  it("advertises exactly the supplied fs callbacks and the full terminal group", async () => {
    const readOnly = new AcpQuery({ fs: { readTextFile: () => ({ content: "" }) } });
    expect(readOnly.clientCapabilities()).toEqual({ fs: { readTextFile: true, writeTextFile: false } });

    const full = new AcpQuery({ fs: memFs().fs, terminal: memTerminal() });
    expect(full.clientCapabilities()).toEqual({
      fs: { readTextFile: true, writeTextFile: true },
      terminal: true,
    });
  });

  it("initialize() sends the derived clientCapabilities to the agent", async () => {
    let seen: Record<string, unknown> | undefined;
    const q = new AcpQuery({ fs: memFs().fs });
    q.connect(mockAcpAgent({ onInitialize: (p) => (seen = p) }), { name: "mock" });
    const res = await q.initialize();
    expect(res.protocolVersion).toBe(1);
    // The SDK's schema layer may add defaults (e.g. auth) — assert on ours.
    expect(seen?.clientCapabilities).toMatchObject({ fs: { readTextFile: true, writeTextFile: true } });
    expect((seen?.clientCapabilities as { terminal?: boolean }).terminal).toBeFalsy();
    // initialize counts as the first successful request ⇒ peer is ready.
    expect(q.status.get("mock")?.state).toBe("ready");
    await q.close();
  });
});

describe("fs handlers", () => {
  it("routes fs/read_text_file and fs/write_text_file to the supplied callbacks", async () => {
    const { files, fs } = memFs({ "/notes.txt": "hello" });
    const hub = new DevtoolsHub<AcpDevtoolsEvent>();
    const q = new AcpQuery({ fs, devtools: hub });
    let read: unknown;
    q.connect(
      mockAcpAgent({
        onPrompt: async ({ sessionId, call }) => {
          read = await call("fs/read_text_file", { sessionId, path: "/notes.txt" });
          await call("fs/write_text_file", { sessionId, path: "/out.txt", content: "written by agent" });
        },
      }),
    );
    const sid = await q.newSession();
    await q.prompt(sid, "go");
    expect(read).toEqual({ content: "hello" });
    expect(files["/out.txt"]).toBe("written by agent");
    const fsEvents = hub.events().filter((e) => e.type === "acp:fs");
    expect(fsEvents).toEqual([
      { type: "acp:fs", sessionId: sid, op: "readTextFile", path: "/notes.txt" },
      { type: "acp:fs", sessionId: sid, op: "writeTextFile", path: "/out.txt" },
    ]);
    await q.close();
  });

  it("propagates callback errors to the agent as request failures", async () => {
    const { fs } = memFs();
    const q = new AcpQuery({ fs });
    let error: unknown;
    q.connect(
      mockAcpAgent({
        onPrompt: async ({ sessionId, call }) => {
          await call("fs/read_text_file", { sessionId, path: "/missing" }).catch((e) => (error = e));
        },
      }),
    );
    const sid = await q.newSession();
    await q.prompt(sid, "go");
    // The SDK maps thrown callback errors to a JSON-RPC internal error.
    expect(error).toBeInstanceOf(Error);
    await q.close();
  });
});

describe("terminal handlers", () => {
  it("routes the full terminal lifecycle to the supplied callbacks", async () => {
    const log: string[] = [];
    const hub = new DevtoolsHub<AcpDevtoolsEvent>();
    const q = new AcpQuery({ terminal: memTerminal(log), devtools: hub });
    let output: unknown;
    let exit: unknown;
    q.connect(
      mockAcpAgent({
        onPrompt: async ({ sessionId, call }) => {
          const { terminalId } = (await call("terminal/create", {
            sessionId,
            command: "echo",
            args: ["hi"],
          })) as { terminalId: string };
          output = await call("terminal/output", { sessionId, terminalId });
          exit = await call("terminal/wait_for_exit", { sessionId, terminalId });
          await call("terminal/kill", { sessionId, terminalId });
          await call("terminal/release", { sessionId, terminalId });
        },
      }),
    );
    const sid = await q.newSession();
    await q.prompt(sid, "run it");
    expect(log).toEqual([
      "create echo",
      "output term-1",
      "waitForExit term-1",
      "kill term-1",
      "release term-1",
    ]);
    expect(output).toEqual({ output: "fake output", truncated: false });
    expect(exit).toEqual({ exitCode: 0 });
    expect(hub.events().filter((e) => e.type === "acp:terminal").map((e) => (e as { op: string }).op)).toEqual([
      "create",
      "output",
      "waitForExit",
      "kill",
      "release",
    ]);
    await q.close();
  });
});

describe("gateWrites", () => {
  it("gates fs writes through the broker: deny policy blocks the callback, reads pass ungated", async () => {
    const { files, fs } = memFs({ "/ok.txt": "readable" });
    const broker = new InteractionBroker<PermissionDecision>({
      policy: ({ type }) => (type === "fs" ? "deny" : "ask"),
    });
    const q = new AcpQuery({ fs, interactions: broker, gateWrites: true });
    let read: unknown;
    let writeError: unknown;
    q.connect(
      mockAcpAgent({
        onPrompt: async ({ sessionId, call }) => {
          read = await call("fs/read_text_file", { sessionId, path: "/ok.txt" }); // ungated
          await call("fs/write_text_file", { sessionId, path: "/blocked.txt", content: "nope" }).catch(
            (e) => (writeError = e),
          );
        },
      }),
      { name: "coder" },
    );
    const sid = await q.newSession();
    await q.prompt(sid, "go");
    expect(read).toEqual({ content: "readable" });
    expect(files["/blocked.txt"]).toBeUndefined(); // callback never ran
    expect(String(writeError)).toContain("denied by broker");
    // Audit trail records the auto-deny under type "fs", peer = connect() name.
    const audit = broker.auditLog().find((e) => e.type === "fs");
    expect(audit?.outcome).toBe("auto-deny");
    expect(audit?.peer).toBe("coder");
    await q.close();
  });

  it("terminal/create waits for a human approval when policy asks; approved ⇒ callback runs", async () => {
    const log: string[] = [];
    const broker = new InteractionBroker<PermissionDecision>(); // default policy: ask
    const q = new AcpQuery({ terminal: memTerminal(log), interactions: broker, gateWrites: true });
    q.connect(
      mockAcpAgent({
        onPrompt: async ({ sessionId, call }) => {
          await call("terminal/create", { sessionId, command: "ls" });
        },
      }),
    );
    const sid = await q.newSession();
    const turn = q.prompt(sid, "list files");
    // Wait for the gate to queue the interaction, then approve it.
    while (broker.list().length === 0) await new Promise((r) => setTimeout(r, 5));
    const pending = broker.list()[0]!;
    expect(pending.type).toBe("terminal");
    expect((pending.payload as { method: string }).method).toBe("terminal/create");
    broker.resolve(pending.id, { action: "approve" });
    await turn;
    expect(log).toEqual(["create ls"]);
    await q.close();
  });

  it("fail safe: gateWrites with NO broker denies writes", async () => {
    const { files, fs } = memFs();
    const q = new AcpQuery({ fs, gateWrites: true });
    let error: unknown;
    q.connect(
      mockAcpAgent({
        onPrompt: async ({ sessionId, call }) => {
          await call("fs/write_text_file", { sessionId, path: "/x", content: "y" }).catch((e) => (error = e));
        },
      }),
    );
    const sid = await q.newSession();
    await q.prompt(sid, "go");
    expect(files["/x"]).toBeUndefined();
    expect(String(error)).toContain("no interactions broker");
    await q.close();
  });

  it("without gateWrites, writes invoke the callback directly (no broker involvement)", async () => {
    const { files, fs } = memFs();
    const broker = new InteractionBroker<PermissionDecision>(); // would ask if consulted
    const q = new AcpQuery({ fs, interactions: broker });
    q.connect(
      mockAcpAgent({
        onPrompt: async ({ sessionId, call }) => {
          await call("fs/write_text_file", { sessionId, path: "/direct.txt", content: "no gate" });
        },
      }),
    );
    const sid = await q.newSession();
    await q.prompt(sid, "go");
    expect(files["/direct.txt"]).toBe("no gate");
    expect(broker.list()).toHaveLength(0);
    expect(broker.auditLog().filter((e) => e.type === "fs")).toHaveLength(0);
    await q.close();
  });
});
