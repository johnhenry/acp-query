// Every fold branch of the session store: message chunks, tool call
// lifecycles, plan / commands / mode updates, and the raw-updates escape
// hatch for kinds acpq doesn't fold specially.

import { describe, it, expect } from "vitest";
import { AcpQuery } from "../src/index.js";
import { mockAcpAgent } from "../src/testing/mockAgent.js";

describe("fold: session/update branches", () => {
  it("folds plan updates into state.plan (entries extracted)", async () => {
    const q = new AcpQuery();
    q.connect(
      mockAcpAgent({
        onPrompt: async ({ update }) => {
          await update({
            sessionUpdate: "plan",
            entries: [
              { content: "read the code", priority: "high", status: "in_progress" },
              { content: "write the fix", priority: "medium", status: "pending" },
            ],
          });
        },
      }),
    );
    const sid = await q.newSession();
    await q.prompt(sid, "plan it");
    const plan = q.session(sid)!.plan as Array<{ content: string; status: string }>;
    expect(plan).toHaveLength(2);
    expect(plan[0]).toMatchObject({ content: "read the code", status: "in_progress" });
    await q.close();
  });

  it("folds available_commands_update into state.availableCommands", async () => {
    const q = new AcpQuery();
    q.connect(
      mockAcpAgent({
        onPrompt: async ({ update }) => {
          await update({
            sessionUpdate: "available_commands_update",
            availableCommands: [{ name: "web", description: "Search the web" }],
          });
        },
      }),
    );
    const sid = await q.newSession();
    await q.prompt(sid, "hi");
    const cmds = q.session(sid)!.availableCommands as Array<{ name: string }>;
    expect(cmds.map((c) => c.name)).toEqual(["web"]);
    await q.close();
  });

  it("folds current_mode_update into state.currentMode", async () => {
    const q = new AcpQuery();
    q.connect(
      mockAcpAgent({
        onPrompt: async ({ update }) => {
          await update({ sessionUpdate: "current_mode_update", currentModeId: "architect" });
        },
      }),
    );
    const sid = await q.newSession();
    await q.prompt(sid, "hi");
    expect(q.session(sid)!.currentMode).toBe("architect");
    await q.close();
  });

  it("kinds acpq does not fold specially still land in updates[]", async () => {
    const q = new AcpQuery();
    q.connect(
      mockAcpAgent({
        onPrompt: async ({ update, say }) => {
          await update({
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: "hmm, let me think" },
          });
          await update({ sessionUpdate: "usage_update", used: 1200, size: 200000 });
          await say("done");
        },
      }),
    );
    const sid = await q.newSession();
    await q.prompt(sid, "hi");
    const s = q.session(sid)!;
    // Thought chunks are NOT agent message text…
    expect(s.messageText).toBe("done");
    // …but every raw update is captured, in arrival order.
    const kinds = s.updates.map((u) => (u as { sessionUpdate: string }).sessionUpdate);
    expect(kinds).toEqual(["agent_thought_chunk", "usage_update", "agent_message_chunk"]);
    await q.close();
  });

  it("tool_call → tool_call_update transitions update status but preserve title/kind", async () => {
    const q = new AcpQuery();
    const seen: string[] = [];
    q.connect(
      mockAcpAgent({
        onPrompt: async ({ toolCall, toolCallUpdate }) => {
          await toolCall("tc1", "Read src/main.ts", "pending");
          await toolCallUpdate("tc1", { status: "in_progress" });
          await toolCallUpdate("tc1", { status: "completed" });
        },
      }),
    );
    const sid = await q.newSession();
    q.subscribe(sid, () => {
      const tc = q.session(sid)?.toolCalls.tc1;
      if (tc) seen.push(tc.status);
    });
    await q.prompt(sid, "read it");
    const tc = q.session(sid)!.toolCalls.tc1!;
    expect(tc.status).toBe("completed");
    expect(tc.title).toBe("Read src/main.ts"); // update carried no title — preserved
    expect(tc.kind).toBe("other");
    expect(seen).toContain("pending");
    expect(seen).toContain("in_progress");
    expect(seen).toContain("completed");
    await q.close();
  });

  it("an update for an unseen sessionId creates its state implicitly", async () => {
    const q = new AcpQuery();
    q.connect(
      mockAcpAgent({
        onPrompt: async ({ update }) => {
          // Emit for a session this store never created via newSession().
          await update(
            { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ghost" } },
            "sess-loaded-elsewhere",
          );
        },
      }),
    );
    const sid = await q.newSession();
    await q.prompt(sid, "hi");
    const ghost = q.session("sess-loaded-elsewhere")!;
    expect(ghost.messageText).toBe("ghost");
    expect(ghost.updates).toHaveLength(1);
    // The prompting session saw none of it.
    expect(q.session(sid)!.updates).toHaveLength(0);
    await q.close();
  });
});
