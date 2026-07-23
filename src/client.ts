// AcpQuery — a reactive session/turn store + permission broker for the Agent
// Client Protocol. The official @agentclientprotocol/sdk gives you the wire
// (fluent client() builder, typed handlers, transports); acpq adds the state
// stratum an embedding app needs: session/update streams folded into a
// cache-backed session store (hooks-ready), and session/request_permission
// routed through the shared InteractionBroker (policy / approval queue / audit)
// — ACP's most distinctive human-in-the-loop primitive.
//
// NOT primarily a query cache: ACP is turn/stream-centric. The cache here is a
// reactive store keyed by session, holding folded turn state.

import { client, type ClientApp, type ClientConnection } from "@agentclientprotocol/sdk";
import {
  InteractionBroker,
  QueryCache,
  type BaseDecision,
} from "@johnhenry/agent-query-core";

// ── decision & state shapes ──────────────────────────────────────────────────

/** Broker decision for a permission request: approve with the chosen optionId. */
export interface PermissionDecision extends BaseDecision {
  optionId?: string;
}

export interface PermissionOption {
  optionId: string;
  name: string;
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always" | string;
}

export interface ToolCallState {
  toolCallId: string;
  title?: string;
  kind?: string;
  status: string;
  raw: unknown;
}

/** Folded, reactive view of one ACP session — what useSession() renders. */
export interface SessionState {
  sessionId: string;
  /** Concatenated agent message text (agent_message_chunk updates). */
  messageText: string;
  /** Tool calls by id, latest status applied. */
  toolCalls: Record<string, ToolCallState>;
  /** The agent's current plan entries, if reported. */
  plan?: unknown;
  /** Slash commands currently available, if reported. */
  availableCommands?: unknown;
  /** Current session mode, if reported. */
  currentMode?: string;
  /** Stop reason of the most recently completed prompt turn. */
  lastStopReason?: string;
  /** Every raw update, in arrival order (devtools / escape hatch). */
  updates: unknown[];
}

export type AcpKey = { kind: "session"; id: string };
export const serializeAcpKey = (k: AcpKey): string => JSON.stringify([k.kind, k.id]);
export const sessionTag = (id: string): string => `session:${id}`;

// ── config ───────────────────────────────────────────────────────────────────

export interface AcpQueryConfig {
  /** Client identity advertised to agents. */
  name?: string;
  /**
   * Human-in-the-loop broker for session/request_permission. Policy verdicts:
   * "allow" auto-picks the first allow_* option, "deny" the first reject_*
   * option (or cancels), "ask" queues for the UI (resolve with an optionId).
   */
  interactions?: InteractionBroker<PermissionDecision>;
}

// ── the store/client ─────────────────────────────────────────────────────────

export class AcpQuery {
  readonly cache: QueryCache<AcpKey>;
  readonly interactions?: InteractionBroker<PermissionDecision>;
  readonly app: ClientApp;
  private conn?: ClientConnection;
  private agentName = "agent";

  constructor(cfg: AcpQueryConfig = {}) {
    this.interactions = cfg.interactions;
    this.cache = new QueryCache<AcpKey>({ serializeKey: serializeAcpKey });
    this.app = client({ name: cfg.name ?? "acpq" })
      .onNotification("session/update", (cx) => {
        const p = cx.params as { sessionId: string; update: Record<string, unknown> };
        this.fold(p.sessionId, p.update);
      })
      .onRequest("session/request_permission", async (cx) => {
        const params = cx.params as {
          sessionId: string;
          toolCall?: unknown;
          options: PermissionOption[];
        };
        return (await this.decidePermission(params)) as never;
      });
  }

  /** Connect to an agent: a transport stream or an in-process AgentApp. */
  connect(agentOrStream: Parameters<ClientApp["connect"]>[0]): ClientConnection {
    // The SDK overloads connect(stream) | connect(agentApp); both accepted here.
    this.conn = this.app.connect(agentOrStream as never);
    return this.conn;
  }

  async close(): Promise<void> {
    this.conn?.close();
  }

  private get agent() {
    if (!this.conn) throw new Error("AcpQuery: connect() first");
    return this.conn.agent;
  }

  // ── sessions & prompting ───────────────────────────────────────────────────
  /** Start a session; its state becomes observable immediately. */
  async newSession(cwd = "/"): Promise<string> {
    const res = (await this.agent.request("session/new", { cwd, mcpServers: [] })) as {
      sessionId: string;
    };
    this.write(this.ensureState(res.sessionId));
    return res.sessionId;
  }

  /**
   * Send a prompt turn. Updates stream into the session state as they arrive;
   * resolves with the stop reason (also recorded on the state).
   */
  async prompt(sessionId: string, text: string): Promise<string> {
    const res = (await this.agent.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text }],
    })) as { stopReason: string };
    const state = this.ensureState(sessionId);
    state.lastStopReason = res.stopReason;
    this.write(state);
    return res.stopReason;
  }

  /** Cancel the current turn (agent must finish with stopReason "cancelled"). */
  async cancel(sessionId: string): Promise<void> {
    await this.agent.notify("session/cancel", { sessionId });
  }

  // ── reactive access (hooks-ready) ─────────────────────────────────────────
  session(sessionId: string): SessionState | undefined {
    return this.cache.getSnapshot({ kind: "session", id: sessionId })?.data as SessionState | undefined;
  }
  subscribe(sessionId: string, fn: () => void): () => void {
    return this.cache.subscribe({ kind: "session", id: sessionId }, fn);
  }

  // ── internals ─────────────────────────────────────────────────────────────
  private ensureState(sessionId: string): SessionState {
    const prev = this.session(sessionId);
    // Clone on read: mutating the cached object in place would make the next
    // write structurally equal to it, defeating change detection (no emit).
    if (prev) return { ...prev };
    return { sessionId, messageText: "", toolCalls: {}, updates: [] };
  }

  private write(state: SessionState): void {
    this.cache.write({ kind: "session", id: state.sessionId }, state, {
      tags: [sessionTag(state.sessionId)],
      staleTime: Number.POSITIVE_INFINITY, // stream-driven, never "stale by age"
    });
  }

  /** Fold one session/update notification into the session state. */
  private fold(sessionId: string, update: Record<string, unknown>): void {
    const state = this.ensureState(sessionId);
    state.updates = [...state.updates, update];
    const kind = String(update.sessionUpdate ?? "");
    switch (kind) {
      case "agent_message_chunk": {
        const content = update.content as { type?: string; text?: string } | undefined;
        if (content?.type === "text" && typeof content.text === "string") {
          state.messageText += content.text;
        }
        break;
      }
      case "tool_call":
      case "tool_call_update": {
        const id = String(update.toolCallId ?? "");
        if (id) {
          const prev = state.toolCalls[id];
          state.toolCalls = {
            ...state.toolCalls,
            [id]: {
              toolCallId: id,
              title: (update.title as string | undefined) ?? prev?.title,
              kind: (update.kind as string | undefined) ?? prev?.kind,
              status: String(update.status ?? prev?.status ?? "pending"),
              raw: update,
            },
          };
        }
        break;
      }
      case "plan":
        state.plan = update.entries ?? update;
        break;
      case "available_commands_update":
        state.availableCommands = update.availableCommands ?? update;
        break;
      case "current_mode_update":
        state.currentMode = String(update.currentModeId ?? "");
        break;
      default:
        break; // unknown update kinds are still captured in `updates`
    }
    this.write(state);
  }

  /** Route a permission request through the broker (or auto-answer sanely). */
  private async decidePermission(params: {
    sessionId: string;
    toolCall?: unknown;
    options: PermissionOption[];
  }): Promise<{ outcome: { outcome: "selected"; optionId: string } | { outcome: "cancelled" } }> {
    const first = (kinds: string[]): PermissionOption | undefined =>
      params.options.find((o) => kinds.some((k) => o.kind.startsWith(k)));
    const allow = first(["allow"]);
    const reject = first(["reject"]);

    if (!this.interactions) {
      // No broker configured: fail safe — reject (or cancel when no reject option).
      return reject
        ? { outcome: { outcome: "selected", optionId: reject.optionId } }
        : { outcome: { outcome: "cancelled" } };
    }

    const { decision } = await this.interactions.gate("permission", this.agentName, params, {
      autoApprove: allow ? { action: "approve", optionId: allow.optionId } : { action: "approve" },
      autoDeny: reject ? { action: "deny", optionId: reject.optionId } : { action: "deny" },
    });
    const optionId =
      decision.optionId ?? (decision.action === "approve" ? allow?.optionId : reject?.optionId);
    return optionId
      ? { outcome: { outcome: "selected", optionId } }
      : { outcome: { outcome: "cancelled" } };
  }
}
