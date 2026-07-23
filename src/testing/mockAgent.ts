// In-process mock ACP agent built on the SDK's own agent() builder — connect it
// straight to an AcpQuery via app.connect(mock.app): the SDK routes the real
// protocol between them with no transport.

import { agent, type AgentApp } from "@agentclientprotocol/sdk";

export interface MockAcpAgentOptions {
  name?: string;
  /**
   * Behavior of a prompt turn. Receives the prompt text and helpers; returns
   * the stop reason (default "end_turn").
   */
  onPrompt?: (ctx: {
    sessionId: string;
    text: string;
    say: (text: string) => Promise<void>;
    toolCall: (id: string, title: string, status?: string) => Promise<void>;
    askPermission: (options?: Array<{ optionId: string; name: string; kind: string }>) => Promise<
      { outcome: "selected"; optionId: string } | { outcome: "cancelled" }
    >;
  }) => Promise<string | void>;
}

export function mockAcpAgent(opts: MockAcpAgentOptions = {}): AgentApp {
  let seq = 0;
  return agent({ name: opts.name ?? "mock-acp-agent" })
    .onRequest("initialize", () => ({ protocolVersion: 1 }) as never)
    .onRequest("session/new", () => ({ sessionId: `sess-${++seq}` }) as never)
    .onRequest("session/prompt", async (cx) => {
      const params = cx.params as { sessionId: string; prompt: Array<{ type?: string; text?: string }> };
      const text = params.prompt.map((b) => b.text ?? "").join("");
      const notify = (update: Record<string, unknown>) =>
        cx.client.notify("session/update", { sessionId: params.sessionId, update } as never);
      const stop = await opts.onPrompt?.({
        sessionId: params.sessionId,
        text,
        say: (t) => notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: t } }),
        toolCall: (id, title, status = "completed") =>
          notify({ sessionUpdate: "tool_call", toolCallId: id, title, status, kind: "other" }),
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
      });
      return { stopReason: stop ?? "end_turn" } as never;
    });
}
