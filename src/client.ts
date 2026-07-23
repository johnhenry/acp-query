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

/**
 * Broker decision for a permission request.
 *
 * - `optionId` — explicitly select one of the agent's offered options
 *   (wins over `action`-based mapping).
 * - `cancelled` — respond with ACP's `{outcome: "cancelled"}` regardless of
 *   `action`. This is the marker `cancel()` uses to honor the spec's contract
 *   that pending permission requests are answered `cancelled` after
 *   `session/cancel`.
 * - otherwise `action: "approve"` maps to the first allow_* option and
 *   `action: "deny"` to the first reject_* option; when no matching option
 *   exists the response degrades to `{outcome: "cancelled"}`.
 */
export interface PermissionDecision extends BaseDecision {
  optionId?: string;
  cancelled?: boolean;
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

export interface ConnectOptions {
  /**
   * Label for this agent as the broker's `peer` — what policy callbacks,
   * the approval inbox, and the audit trail see. Default `"agent"`.
   */
  name?: string;
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

  /**
   * Connect to an agent: a transport stream or an in-process AgentApp.
   *
   * One connection at a time — call `close()` before connecting again
   * (a second `connect()` while connected throws). `opts.name` labels the
   * agent in broker interactions and audit entries.
   */
  connect(agentOrStream: Parameters<ClientApp["connect"]>[0], opts: ConnectOptions = {}): ClientConnection {
    if (this.conn) {
      throw new Error("AcpQuery: already connected — close() before connecting again");
    }
    // The SDK overloads connect(stream) | connect(agentApp); both accepted here.
    const conn = this.app.connect(agentOrStream as never);
    this.conn = conn;
    this.agentName = opts.name ?? "agent";
    // If the connection dies out from under us, allow a fresh connect().
    const clear = () => {
      if (this.conn === conn) this.conn = undefined;
    };
    conn.closed.then(clear, clear);
    return conn;
  }

  /** Close the connection (if any) and wait until it has fully shut down. */
  async close(): Promise<void> {
    const conn = this.conn;
    if (!conn) return;
    this.conn = undefined;
    conn.close();
    await conn.closed.catch(() => {});
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
    // Fold-style read-modify-write with NO awaits between read and write:
    // ensureState() clones the *latest* snapshot (any session/update folds
    // that landed while we awaited the response are already in it), we set the
    // stop reason, and write synchronously — nothing can interleave between
    // the read and the write, and a fold arriving afterwards re-reads this
    // state, so neither side clobbers the other.
    const state = this.ensureState(sessionId);
    state.lastStopReason = res.stopReason;
    this.write(state);
    return res.stopReason;
  }

  /**
   * Cancel the current turn (agent must finish with stopReason "cancelled").
   *
   * Per the ACP spec, after sending `session/cancel` the client MUST respond
   * to that session's pending `session/request_permission` requests with
   * `{outcome: "cancelled"}` — so this also resolves any pending broker
   * interactions of type "permission" for this session with a cancelled
   * decision (audited as denied, reason "session/cancel").
   */
  async cancel(sessionId: string): Promise<void> {
    await this.agent.notify("session/cancel", { sessionId });
    if (this.interactions) {
      for (const pending of this.interactions.list()) {
        if (
          pending.type === "permission" &&
          (pending.payload as { sessionId?: string } | undefined)?.sessionId === sessionId
        ) {
          this.interactions.resolve(pending.id, {
            action: "deny",
            cancelled: true,
            reason: "session/cancel",
          });
        }
      }
    }
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

  /**
   * Fold one session/update notification into the session state.
   *
   * Note: an update for a sessionId this store has never seen creates its
   * state implicitly — agents may stream updates for sessions established
   * elsewhere (e.g. `session/load`) before this store knows about them. The
   * implicit state is indistinguishable from one created by `newSession()`.
   */
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

  /**
   * Route a permission request through the broker (or auto-answer sanely).
   *
   * Decision → wire mapping (in precedence order):
   * 1. `decision.cancelled` → `{outcome: "cancelled"}`
   * 2. explicit `decision.optionId` → `{outcome: "selected", optionId}`
   * 3. `action: "approve"` → first allow_* option; `"deny"` → first reject_*
   * 4. no matching option → `{outcome: "cancelled"}`
   */
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
    if (decision.cancelled) return { outcome: { outcome: "cancelled" } };
    const optionId =
      decision.optionId ?? (decision.action === "approve" ? allow?.optionId : reject?.optionId);
    return optionId
      ? { outcome: { outcome: "selected", optionId } }
      : { outcome: { outcome: "cancelled" } };
  }
}
