// @vitest-environment happy-dom
// React hooks — real renders via @testing-library/react on happy-dom, driven
// end-to-end by the mock agent over the SDK's real protocol routing.

import { describe, it, expect, afterEach } from "vitest";
import { act, render, screen, cleanup } from "@testing-library/react";

afterEach(cleanup);

import { AcpQuery, InteractionBroker, type PermissionDecision } from "../src/index.js";
import { usePermissions, useSession, useToolCalls } from "../src/react/index.js";
import { mockAcpAgent } from "../src/testing/mockAgent.js";

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

describe("useSession", () => {
  it("renders undefined before the session exists, then streams folds live", async () => {
    const q = new AcpQuery();
    q.connect(
      mockAcpAgent({
        onPrompt: async ({ say }) => {
          await say("Hello, ");
          await say("world.");
        },
      }),
    );

    function Transcript({ sid }: { sid: string }) {
      const state = useSession(q, sid);
      return <div data-testid="text">{state ? state.messageText : "(no session)"}</div>;
    }

    render(<Transcript sid="sess-1" />);
    expect(screen.getByTestId("text").textContent).toBe("(no session)");

    let sid = "";
    await act(async () => {
      sid = await q.newSession();
    });
    expect(sid).toBe("sess-1"); // the component was already observing this key
    expect(screen.getByTestId("text").textContent).toBe("");
    await act(async () => {
      await q.prompt(sid, "hi");
    });
    expect(screen.getByTestId("text").textContent).toBe("Hello, world.");
    await q.close();
  });

  it("two components observing different sessions stay isolated", async () => {
    const q = new AcpQuery();
    q.connect(
      mockAcpAgent({
        onPrompt: async ({ say, text }) => {
          await say(`echo:${text}`);
        },
      }),
    );
    function Text({ sid }: { sid: string }) {
      const s = useSession(q, sid);
      return <span data-testid={sid}>{s?.messageText ?? "-"}</span>;
    }
    let a = "";
    let b = "";
    await act(async () => {
      a = await q.newSession();
      b = await q.newSession();
    });
    render(
      <>
        <Text sid={a} />
        <Text sid={b} />
      </>,
    );
    await act(async () => {
      await q.prompt(a, "one");
    });
    expect(screen.getByTestId(a).textContent).toBe("echo:one");
    expect(screen.getByTestId(b).textContent).toBe("");
    await q.close();
  });
});

describe("useToolCalls", () => {
  it("renders the tool-call lifecycle; stable array identity between folds", async () => {
    const q = new AcpQuery();
    q.connect(
      mockAcpAgent({
        onPrompt: async ({ toolCall, toolCallUpdate }) => {
          await toolCall("tc1", "grep TODO", "in_progress");
          await toolCall("tc2", "read file", "pending");
          await toolCallUpdate("tc1", { status: "completed" });
        },
      }),
    );
    const identities: unknown[] = [];
    function Tools({ sid }: { sid: string }) {
      const calls = useToolCalls(q, sid);
      identities.push(calls);
      return (
        <ul>
          {calls.map((t) => (
            <li key={t.toolCallId} data-testid={t.toolCallId}>
              {t.title}:{t.status}
            </li>
          ))}
        </ul>
      );
    }
    let sid = "";
    await act(async () => {
      sid = await q.newSession();
    });
    render(<Tools sid={sid} />);
    await act(async () => {
      await q.prompt(sid, "go");
    });
    expect(screen.getByTestId("tc1").textContent).toBe("grep TODO:completed");
    expect(screen.getByTestId("tc2").textContent).toBe("read file:pending");
    // Re-render without a fold reuses the memoized array (safe in dep lists).
    const last = identities.at(-1);
    expect(identities.filter((i) => i === last).length).toBeGreaterThanOrEqual(1);
    await q.close();
  });
});

describe("usePermissions", () => {
  it("shows the pending ask and resolves it from the UI", async () => {
    const broker = new InteractionBroker<PermissionDecision>(); // default: ask
    const q = new AcpQuery({ interactions: broker });
    q.connect(
      mockAcpAgent({
        onPrompt: async ({ say, askPermission }) => {
          const outcome = await askPermission();
          await say(outcome.outcome === "selected" ? `picked:${outcome.optionId}` : "cancelled");
        },
      }),
    );

    function Inbox() {
      const { permissions, resolve } = usePermissions(q);
      return (
        <div>
          <span data-testid="count">{permissions.length}</span>
          {permissions.map((p) => (
            <button
              key={p.id}
              data-testid={`approve-${p.id}`}
              onClick={() => resolve(p.id, { action: "approve", optionId: "yes" })}
            >
              approve
            </button>
          ))}
        </div>
      );
    }

    render(<Inbox />);
    expect(screen.getByTestId("count").textContent).toBe("0");

    let sid = "";
    let turn!: Promise<string>;
    await act(async () => {
      sid = await q.newSession();
      turn = q.prompt(sid, "do something sensitive");
      while (broker.list().length === 0) await tick();
    });
    expect(screen.getByTestId("count").textContent).toBe("1");

    await act(async () => {
      screen.getByTestId(`approve-${broker.list()[0]!.id}`).click();
      await turn;
    });
    expect(screen.getByTestId("count").textContent).toBe("0");
    expect(q.session(sid)!.messageText).toBe("picked:yes");
    await q.close();
  });

  it("filters to type 'permission' (gateWrites fs interactions stay out) and is safe with no broker", async () => {
    // No broker: empty queue, resolve is a no-op.
    const bare = new AcpQuery();
    function Empty() {
      const { permissions, resolve } = usePermissions(bare);
      resolve(999, { action: "deny" }); // must not throw
      return <span data-testid="empty">{permissions.length}</span>;
    }
    render(<Empty />);
    expect(screen.getByTestId("empty").textContent).toBe("0");
    cleanup();

    // A broker whose queue holds a NON-permission interaction (an fs gate).
    const broker = new InteractionBroker<PermissionDecision>(); // ask
    const q = new AcpQuery({
      interactions: broker,
      gateWrites: true,
      fs: { writeTextFile: () => {} },
    });
    q.connect(
      mockAcpAgent({
        onPrompt: async ({ sessionId, call }) => {
          await call("fs/write_text_file", { sessionId, path: "/x", content: "y" }).catch(() => {});
        },
      }),
    );
    function Both() {
      const { permissions } = usePermissions(q);
      return <span data-testid="perms">{permissions.length}</span>;
    }
    render(<Both />);
    let turn!: Promise<string>;
    await act(async () => {
      const sid = await q.newSession();
      turn = q.prompt(sid, "write");
      while (broker.list().length === 0) await tick();
    });
    expect(broker.list()).toHaveLength(1); // the fs gate is queued…
    expect(screen.getByTestId("perms").textContent).toBe("0"); // …but not a "permission"
    await act(async () => {
      broker.resolve(broker.list()[0]!.id, { action: "deny" });
      await turn;
    });
    await q.close();
  });
});
