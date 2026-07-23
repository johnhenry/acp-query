// In-process mock ACP agent built on the SDK's own agent() builder — connect it
// straight to an AcpQuery via q.connect(mockAcpAgent(...)): the SDK routes the
// real protocol between them with no transport.

import { agent, type AgentApp } from "@agentclientprotocol/sdk";

export interface MockPromptContext {
  sessionId: string;
  /** The concatenated text of the prompt's content blocks. */
  text: string;
  /** Stream an agent_message_chunk. */
  say: (text: string) => Promise<void>;
  /** Stream a tool_call update (status defaults to "completed"). */
  toolCall: (id: string, title: string, status?: string) => Promise<void>;
  /** Stream a tool_call_update patch for a previously reported tool call. */
  toolCallUpdate: (id: string, patch?: Record<string, unknown>) => Promise<void>;
  /**
   * Stream any raw session/update payload (plan, current_mode_update, …).
   * Pass `sessionId` to emit for a different session than the current turn's
   * (e.g. to exercise implicit session creation on the client).
   */
  update: (update: Record<string, unknown>, sessionId?: string) => Promise<void>;
  /** Ask the client for permission (session/request_permission). */
  askPermission: (options?: Array<{ optionId: string; name: string; kind: string }>) => Promise<
    { outcome: "selected"; optionId: string } | { outcome: "cancelled" }
  >;
  /** True once the client has sent session/cancel for this session's turn. */
  cancelled: () => boolean;
  /** Resolves when the client sends session/cancel (never, if it doesn't). */
  whenCancelled: Promise<void>;
}

export interface MockAcpAgentOptions {
  name?: string;
  /**
   * Behavior of a prompt turn. Receives the prompt text and helpers; returns
   * the stop reason (default "end_turn" — or "cancelled" when the client
   * cancelled the turn, honoring the ACP prompt-turn contract).
   */
  onPrompt?: (ctx: MockPromptContext) => Promise<string | void>;
}

export function mockAcpAgent(opts: MockAcpAgentOptions = {}): AgentApp {
  let seq = 0;
  const cancelledSessions = new Set<string>();
  const cancelWaiters = new Map<string, Array<() => void>>();
  return agent({ name: opts.name ?? "mock-acp-agent" })
    .onRequest("initialize", () => ({ protocolVersion: 1 }) as never)
    .onRequest("session/new", () => ({ sessionId: `sess-${++seq}` }) as never)
    .onNotification("session/cancel", (cx) => {
      const { sessionId } = cx.params as { sessionId: string };
      cancelledSessions.add(sessionId);
      for (const wake of cancelWaiters.get(sessionId) ?? []) wake();
      cancelWaiters.delete(sessionId);
    })
    .onRequest("session/prompt", async (cx) => {
      const params = cx.params as { sessionId: string; prompt: Array<{ type?: string; text?: string }> };
      const text = params.prompt.map((b) => b.text ?? "").join("");
      cancelledSessions.delete(params.sessionId); // fresh turn
      const notify = (update: Record<string, unknown>, sessionId = params.sessionId) =>
        cx.client.notify("session/update", { sessionId, update } as never);
      const stop = await opts.onPrompt?.({
        sessionId: params.sessionId,
        text,
        say: (t) => notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: t } }),
        toolCall: (id, title, status = "completed") =>
          notify({ sessionUpdate: "tool_call", toolCallId: id, title, status, kind: "other" }),
        toolCallUpdate: (id, patch = {}) =>
          notify({ sessionUpdate: "tool_call_update", toolCallId: id, ...patch }),
        update: (update, sessionId) => notify(update, sessionId),
        askPermission: async (options) => {
          const res = (await cx.client.request("session/request_permission", {
            sessionId: params.sessionId,
            toolCall: { toolCallId: "tc-perm", title: "sensitive op" },
            options:
              options ??
              ([
                { optionId: "yes", name: "Allow", kind: "allow_once" },
                { optionId: "no", name: "Reject", kind: "reject_once" },
              ] as never),
          } as never)) as { outcome: { outcome: "selected"; optionId: string } | { outcome: "cancelled" } };
          return res.outcome;
        },
        cancelled: () => cancelledSessions.has(params.sessionId),
        whenCancelled: new Promise<void>((resolve) => {
          if (cancelledSessions.has(params.sessionId)) return resolve();
          const waiters = cancelWaiters.get(params.sessionId) ?? [];
          waiters.push(resolve);
          cancelWaiters.set(params.sessionId, waiters);
        }),
      });
      const stopReason = stop ?? (cancelledSessions.has(params.sessionId) ? "cancelled" : "end_turn");
      return { stopReason } as never;
    });
}
