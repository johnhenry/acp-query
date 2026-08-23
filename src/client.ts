// AcpQuery — a reactive session/turn store + permission broker for the Agent
// Client Protocol. The official @agentclientprotocol/sdk gives you the wire
// (fluent client() builder, typed handlers, transports); acp-query adds the state
// stratum an embedding app needs: session/update streams folded into a
// cache-backed session store (hooks-ready), and session/request_permission
// routed through the shared InteractionBroker (policy / approval queue / audit)
// — ACP's most distinctive human-in-the-loop primitive.
//
// NOT primarily a query cache: ACP is turn/stream-centric. The cache here is a
// reactive store keyed by session, holding folded turn state.

import {
  client,
  PROTOCOL_VERSION,
  RequestError,
  type ClientApp,
  type ClientConnection,
  type Stream,
} from "@agentclientprotocol/sdk";
import type {
  ClientCapabilities,
  ListSessionsResponse,
  SessionInfo,
  CreateTerminalRequest,
  CreateTerminalResponse,
  InitializeResponse,
  KillTerminalRequest,
  KillTerminalResponse,
  ReadTextFileRequest,
  ReadTextFileResponse,
  ReleaseTerminalRequest,
  ReleaseTerminalResponse,
  TerminalOutputRequest,
  TerminalOutputResponse,
  WaitForTerminalExitRequest,
  WaitForTerminalExitResponse,
  WriteTextFileRequest,
  WriteTextFileResponse,
} from "@agentclientprotocol/sdk";
import { AcpSessionHandle } from "./session.js";
import {
  InteractionBroker,
  QueryCache,
  StatusStore,
  type BaseDecision,
  type ConnectivityState,
  type DevtoolsSink,
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

export type AcpKey =
  | { kind: "session"; id: string }
  /** The cached session/list read (one entry per cwd filter; "" = unfiltered). */
  | { kind: "session-list"; cwd?: string }
  /** A session's available slash commands, separately keyed from its fold. */
  | { kind: "commands"; id: string };
export const serializeAcpKey = (k: AcpKey): string => {
  switch (k.kind) {
    case "session":
    case "commands":
      return JSON.stringify([k.kind, k.id]);
    case "session-list":
      return JSON.stringify([k.kind, k.cwd ?? ""]);
  }
};
export const sessionTag = (id: string): string => `session:${id}`;
/** Tag on every cached session/list entry — invalidated when membership changes. */
export const sessionsTag = "acp:sessions";

// ── client capabilities (fs / terminal) ──────────────────────────────────────

type MaybePromise<T> = T | Promise<T>;

/**
 * User-supplied file-system callbacks. **Nothing is built in**: acp-query never
 * touches the real filesystem — it only wires the callbacks you provide onto
 * the SDK's `fs/read_text_file` / `fs/write_text_file` handlers and advertises
 * the matching `clientCapabilities.fs` flags. Omit a callback and the method
 * is neither registered nor advertised (security default: OFF).
 */
export interface AcpFsHandlers {
  readTextFile?: (params: ReadTextFileRequest) => MaybePromise<ReadTextFileResponse>;
  writeTextFile?: (params: WriteTextFileRequest) => MaybePromise<WriteTextFileResponse | void>;
}

/**
 * User-supplied terminal callbacks. ACP's `terminal` capability is
 * all-or-nothing ("the Client supports all `terminal/*` methods"), so every
 * method is required — supply the whole group or none. As with fs, acp-query spawns
 * nothing itself; it only routes the agent's requests to your callbacks.
 */
export interface AcpTerminalHandlers {
  create: (params: CreateTerminalRequest) => MaybePromise<CreateTerminalResponse>;
  output: (params: TerminalOutputRequest) => MaybePromise<TerminalOutputResponse>;
  release: (params: ReleaseTerminalRequest) => MaybePromise<ReleaseTerminalResponse | void>;
  waitForExit: (params: WaitForTerminalExitRequest) => MaybePromise<WaitForTerminalExitResponse>;
  kill: (params: KillTerminalRequest) => MaybePromise<KillTerminalResponse | void>;
}

// ── config ───────────────────────────────────────────────────────────────────

/**
 * Compact, serializable devtools event vocabulary emitted when
 * `AcpQueryConfig.devtools` is configured. See docs/design.md for the table.
 */
export type AcpDevtoolsEvent =
  | { type: "acp:turn-start"; sessionId: string }
  | { type: "acp:turn-end"; sessionId: string; stopReason: string }
  | {
      type: "acp:update";
      sessionId: string;
      kind: string;
      /** tool_call / tool_call_update only: enough to render a timeline row. */
      toolCallId?: string;
      status?: string;
      title?: string;
    }
  | { type: "acp:permission-request"; sessionId: string; options: number }
  | { type: "acp:permission-decision"; sessionId: string; outcome: "selected" | "cancelled"; optionId?: string }
  | { type: "acp:status"; peer: string; state: ConnectivityState }
  | { type: "acp:cancel"; sessionId: string }
  | { type: "acp:wire"; dir: "in" | "out"; method?: string; id?: string | number }
  | { type: "acp:fs"; sessionId: string; op: "readTextFile" | "writeTextFile"; path: string }
  | {
      type: "acp:terminal";
      sessionId: string;
      op: "create" | "output" | "release" | "waitForExit" | "kill";
      command?: string;
      terminalId?: string;
    };

export interface AcpQueryConfig {
  /** Client identity advertised to agents. */
  name?: string;
  /**
   * Human-in-the-loop broker for session/request_permission. Policy verdicts:
   * "allow" auto-picks the first allow_* option, "deny" the first reject_*
   * option (or cancels), "ask" queues for the UI (resolve with an optionId).
   */
  interactions?: InteractionBroker<PermissionDecision>;
  /**
   * Peer-connectivity store. Defaults to a fresh `StatusStore`; inject a
   * shared one to aggregate acp-query's agent alongside other adapters' peers.
   * The peer name is the `connect()` label (`ConnectOptions.name`).
   */
  status?: StatusStore;
  /**
   * Devtools sink (e.g. a `DevtoolsHub`). When configured, acp-query emits the
   * compact `AcpDevtoolsEvent` vocabulary (turn/update/permission/status/
   * cancel). No-op when absent.
   */
  devtools?: DevtoolsSink<AcpDevtoolsEvent>;
  /**
   * File-system callbacks. A handler is registered (and its capability
   * advertised by `initialize()`) ONLY for the callbacks you supply — with no
   * `fs` config the agent's fs requests fail as unhandled methods.
   */
  fs?: AcpFsHandlers;
  /**
   * Terminal callbacks (all five methods, or nothing). Registered and
   * advertised only when supplied — default OFF.
   */
  terminal?: AcpTerminalHandlers;
  /**
   * Route WRITE-side capability requests (`fs/write_text_file`,
   * `terminal/create`) through the `interactions` broker before invoking your
   * callback: policy first, then the approval inbox on "ask", every outcome
   * audited (types `"fs"` / `"terminal"`). Reads pass through ungated.
   * Fail-safe: `gateWrites: true` with NO broker configured denies writes.
   */
  gateWrites?: boolean;
  /**
   * Staleness window (ms) for cached `listSessions()` reads. Within it,
   * repeat calls return the cache without touching the agent. Default 30_000.
   */
  listStaleTime?: number;
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
  /**
   * Per-peer connectivity (peer = the `connect()` label). Lifecycle:
   * "connecting" on connect(), "ready" after the first successful request
   * over the connection, "closed" on close() or when the connection dies.
   */
  readonly status: StatusStore;
  readonly app: ClientApp;
  private conn?: ClientConnection;
  private agentName = "agent";
  private connReady = false;
  private devtools?: DevtoolsSink<AcpDevtoolsEvent>;
  private fs?: AcpFsHandlers;
  private terminal?: AcpTerminalHandlers;
  private gateWrites: boolean;
  private listStaleTime: number;

  constructor(cfg: AcpQueryConfig = {}) {
    this.listStaleTime = cfg.listStaleTime ?? 30_000;
    this.interactions = cfg.interactions;
    this.status = cfg.status ?? new StatusStore();
    this.devtools = cfg.devtools;
    this.fs = cfg.fs;
    this.terminal = cfg.terminal;
    this.gateWrites = cfg.gateWrites ?? false;
    this.cache = new QueryCache<AcpKey>({ serializeKey: serializeAcpKey });
    this.app = client({ name: cfg.name ?? "acp-query" })
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
    this.registerCapabilityHandlers(cfg);
  }

  /**
   * Register fs/terminal handlers for exactly the callbacks the caller
   * supplied. Nothing here reads files or spawns processes — the library only
   * routes the agent's requests to user code (and gates the write side through
   * the broker when `gateWrites` is on).
   */
  private registerCapabilityHandlers(cfg: AcpQueryConfig): void {
    const fs = cfg.fs;
    if (fs?.readTextFile) {
      const read = fs.readTextFile.bind(fs);
      this.app.onRequest("fs/read_text_file", async (cx) => {
        const p = cx.params;
        this.devtools?.emit({ type: "acp:fs", sessionId: p.sessionId, op: "readTextFile", path: p.path });
        return await read(p);
      });
    }
    if (fs?.writeTextFile) {
      const write = fs.writeTextFile.bind(fs);
      this.app.onRequest("fs/write_text_file", async (cx) => {
        const p = cx.params;
        this.devtools?.emit({ type: "acp:fs", sessionId: p.sessionId, op: "writeTextFile", path: p.path });
        await this.gateWrite("fs", "fs/write_text_file", p);
        return (await write(p)) ?? {};
      });
    }
    const term = cfg.terminal;
    if (term) {
      this.app
        .onRequest("terminal/create", async (cx) => {
          const p = cx.params;
          this.devtools?.emit({ type: "acp:terminal", sessionId: p.sessionId, op: "create", command: p.command });
          await this.gateWrite("terminal", "terminal/create", p);
          return await term.create(p);
        })
        .onRequest("terminal/output", async (cx) => {
          const p = cx.params;
          this.devtools?.emit({ type: "acp:terminal", sessionId: p.sessionId, op: "output", terminalId: p.terminalId });
          return await term.output(p);
        })
        .onRequest("terminal/release", async (cx) => {
          const p = cx.params;
          this.devtools?.emit({ type: "acp:terminal", sessionId: p.sessionId, op: "release", terminalId: p.terminalId });
          return (await term.release(p)) ?? {};
        })
        .onRequest("terminal/wait_for_exit", async (cx) => {
          const p = cx.params;
          this.devtools?.emit({
            type: "acp:terminal",
            sessionId: p.sessionId,
            op: "waitForExit",
            terminalId: p.terminalId,
          });
          return await term.waitForExit(p);
        })
        .onRequest("terminal/kill", async (cx) => {
          const p = cx.params;
          this.devtools?.emit({ type: "acp:terminal", sessionId: p.sessionId, op: "kill", terminalId: p.terminalId });
          return (await term.kill(p)) ?? {};
        });
    }
  }

  /**
   * The broker gate on WRITE-side capability requests. No-op unless
   * `gateWrites` is on; with it on and no broker configured, writes are
   * denied (fail safe). A denied gate throws — the SDK maps it to a JSON-RPC
   * error on the agent's request.
   */
  private async gateWrite(type: "fs" | "terminal", method: string, params: unknown): Promise<void> {
    if (!this.gateWrites) return;
    if (!this.interactions) {
      throw new RequestError(
        -32000,
        `acp-query: ${method} denied — gateWrites is on but no interactions broker is configured`,
      );
    }
    const { decision } = await this.interactions.gate(type, this.agentName, { method, params });
    if (decision.action !== "approve" || decision.cancelled) {
      throw new RequestError(
        -32000,
        `acp-query: ${method} denied by broker${decision.reason ? ` (${decision.reason})` : ""}`,
      );
    }
  }

  /**
   * The `ClientCapabilities` this instance advertises — derived purely from
   * which callbacks were configured: `fs.readTextFile` / `fs.writeTextFile`
   * per supplied fs callback, `terminal: true` only with the full terminal
   * group. No config ⇒ `{}`.
   */
  clientCapabilities(): ClientCapabilities {
    const caps: ClientCapabilities = {};
    if (this.fs?.readTextFile || this.fs?.writeTextFile) {
      caps.fs = {
        readTextFile: Boolean(this.fs.readTextFile),
        writeTextFile: Boolean(this.fs.writeTextFile),
      };
    }
    if (this.terminal) caps.terminal = true;
    return caps;
  }

  /**
   * Send `initialize`, advertising `clientCapabilities()`. Optional — the
   * mock agent doesn't require it — but real agents gate fs/terminal requests
   * on the capabilities advertised here, so call it before `newSession()`
   * when capabilities are configured.
   */
  async initialize(): Promise<InitializeResponse> {
    const res = await this.agent.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: this.clientCapabilities(),
    });
    this.markReady();
    return res;
  }

  /**
   * Connect to an agent: a transport stream or an in-process AgentApp.
   *
   * One connection at a time — call `close()` before connecting again
   * (a second `connect()` while connected throws). `opts.name` labels the
   * agent in broker interactions and audit entries.
   */
  connect(
    agentOrStream: Stream | Parameters<ClientApp["connect"]>[0],
    opts: ConnectOptions = {},
  ): ClientConnection {
    if (this.conn) {
      throw new Error("AcpQuery: already connected — close() before connecting again");
    }
    // The SDK overloads connect(stream) | connect(agentApp); both accepted here.
    const conn = this.app.connect(agentOrStream as never);
    this.conn = conn;
    this.agentName = opts.name ?? "agent";
    this.connReady = false;
    // connect() is synchronous and performs no I/O (the SDK sends nothing
    // until the first request), so "connecting" is the honest state here;
    // "ready" is set by the first successful request over this connection.
    this.setStatus("connecting");
    // If the connection dies out from under us, allow a fresh connect().
    const clear = () => {
      if (this.conn === conn) {
        this.conn = undefined;
        this.setStatus("closed");
      }
    };
    conn.closed.then(clear, clear);
    return conn;
  }

  /** Close the connection (if any) and wait until it has fully shut down. */
  async close(): Promise<void> {
    const conn = this.conn;
    if (!conn) return;
    this.conn = undefined;
    this.setStatus("closed");
    conn.close();
    await conn.closed.catch(() => {});
  }

  private setStatus(state: ConnectivityState): void {
    this.status.set(this.agentName, { state });
    this.devtools?.emit({ type: "acp:status", peer: this.agentName, state });
  }

  /** First successful request over the current connection ⇒ peer is "ready". */
  private markReady(): void {
    if (this.conn && !this.connReady) {
      this.connReady = true;
      this.setStatus("ready");
    }
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
    this.markReady();
    this.write(this.ensureState(res.sessionId));
    // Membership changed: every cached session/list read is now suspect.
    this.cache.invalidateTags([sessionsTag]);
    return res.sessionId;
  }

  /**
   * Cached `session/list`. Pagination is followed to the end (the cursor is a
   * transport detail, not part of the read). Within `listStaleTime` of the
   * last fetch the cache answers without touching the agent; concurrent calls
   * share one in-flight request. `newSession()` invalidates the cache (tag
   * `sessionsTag`); `{force: true}` bypasses it.
   *
   * The entry is keyed per `cwd` filter (`{kind: "session-list", cwd}`) and
   * observable via `q.cache` like any other entry.
   */
  async listSessions(opts: { cwd?: string; force?: boolean } = {}): Promise<SessionInfo[]> {
    const key: AcpKey = { kind: "session-list", ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}) };
    const entry = this.cache.getSnapshot(key);
    if (!opts.force && entry?.data && !this.cache.isStale(key)) {
      return entry.data as SessionInfo[];
    }
    const inflight = this.cache.inflight(key);
    if (inflight) return inflight as Promise<SessionInfo[]>;
    const fetch = (async () => {
      try {
        const sessions: SessionInfo[] = [];
        let cursor: string | null | undefined;
        do {
          const res: ListSessionsResponse = await this.agent.request("session/list", {
            ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
            ...(cursor ? { cursor } : {}),
          });
          sessions.push(...res.sessions);
          cursor = res.nextCursor;
        } while (cursor);
        this.markReady();
        this.cache.write(key, sessions, { tags: [sessionsTag], staleTime: this.listStaleTime });
        return sessions;
      } catch (err) {
        this.cache.setError(key, err instanceof Error ? err : new Error(String(err)));
        throw err;
      } finally {
        this.cache.setInflight(key, undefined);
      }
    })();
    this.cache.setFetching(key);
    this.cache.setInflight(key, fetch);
    return fetch;
  }

  /**
   * `session/load` — resume an existing session, replaying its history.
   *
   * Family rule: **a load IS the reconcile read.** The agent replays the
   * session's full history as ordinary `session/update` notifications, so any
   * pre-existing folded state (gappy after a reconnect, or stale from an
   * earlier attach) is discarded first — the replayed fold is the complete
   * truth, and folding on top of leftovers would double-count it. Subscribers
   * survive: they see the reset, then the replay stream, live.
   *
   * Resolves with the replayed `SessionState` (also observable mid-replay via
   * `session()`/`subscribe()`). `currentMode` is seeded from the response's
   * mode state when the agent reports one.
   */
  async loadSession(sessionId: string, cwd = "/"): Promise<SessionState> {
    this.write({ sessionId, messageText: "", toolCalls: {}, updates: [] });
    const res = await this.agent.request("session/load", { sessionId, cwd, mcpServers: [] });
    this.markReady();
    const state = this.ensureState(sessionId);
    const modeId = res?.modes?.currentModeId;
    if (typeof modeId === "string" && modeId) state.currentMode = modeId;
    this.write(state);
    return this.session(sessionId)!;
  }

  /**
   * Send a prompt turn. Updates stream into the session state as they arrive;
   * resolves with the stop reason (also recorded on the state).
   *
   * Deliberately NOT wrapped in `withRetry`: a prompt turn is non-idempotent
   * (the agent may have streamed text, run tools, or asked permissions before
   * the failure), and the core's retry contract (`withRetry` — retries only
   * with an explicit `idempotent: true` assertion) forbids retrying such a
   * call. Recovery from a failed turn is the app's decision: re-prompt or
   * start a fresh session.
   */
  async prompt(sessionId: string, text: string): Promise<string> {
    this.devtools?.emit({ type: "acp:turn-start", sessionId });
    const res = (await this.agent.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text }],
    })) as { stopReason: string };
    this.markReady();
    this.devtools?.emit({ type: "acp:turn-end", sessionId, stopReason: res.stopReason });
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
    this.devtools?.emit({ type: "acp:cancel", sessionId });
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

  /**
   * Bind one sessionId to a thin handle: `prompt` / `cancel` / `state` /
   * `subscribe` / `toolCalls` / `states()` without re-passing the id. Pure
   * sugar — every call delegates to the corresponding AcpQuery method, so the
   * store stays the single source of truth (handles for the same session see
   * identical state). Works for ids from `newSession()`, `listSessions()`, or
   * sessions established elsewhere.
   */
  attach(sessionId: string): AcpSessionHandle {
    return new AcpSessionHandle(this, sessionId);
  }

  /** `newSession()` + `attach()` in one step. */
  async newAttachedSession(cwd = "/"): Promise<AcpSessionHandle> {
    return this.attach(await this.newSession(cwd));
  }

  /**
   * A session's available slash commands as their own cache entry
   * (`{kind: "commands", id}`), maintained by `available_commands_update`
   * folds — so a command palette can subscribe to just the commands without
   * re-rendering on every message chunk. Also mirrored on
   * `SessionState.availableCommands`.
   */
  commands(sessionId: string): unknown[] | undefined {
    return this.cache.getSnapshot({ kind: "commands", id: sessionId })?.data as unknown[] | undefined;
  }
  subscribeCommands(sessionId: string, fn: () => void): () => void {
    return this.cache.subscribe({ kind: "commands", id: sessionId }, fn);
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
    this.devtools?.emit({
      type: "acp:update",
      sessionId,
      kind,
      // Tool-call rows carry enough to render a timeline without digging into
      // SessionState.updates: the id, latest status, and title (when sent).
      ...(kind === "tool_call" || kind === "tool_call_update"
        ? {
            ...(typeof update.toolCallId === "string" ? { toolCallId: update.toolCallId } : {}),
            ...(typeof update.status === "string" ? { status: update.status } : {}),
            ...(typeof update.title === "string" ? { title: update.title } : {}),
          }
        : {}),
    });
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
      case "available_commands_update": {
        state.availableCommands = update.availableCommands ?? update;
        // Separately-keyed entry: command palettes subscribe to this alone.
        const list = Array.isArray(update.availableCommands) ? update.availableCommands : [];
        this.cache.write({ kind: "commands", id: sessionId }, list, {
          tags: [sessionTag(sessionId)],
          staleTime: Number.POSITIVE_INFINITY, // stream-maintained, like the session fold
        });
        break;
      }
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
    this.devtools?.emit({
      type: "acp:permission-request",
      sessionId: params.sessionId,
      options: params.options.length,
    });
    const result = await this.resolvePermission(params);
    this.devtools?.emit({
      type: "acp:permission-decision",
      sessionId: params.sessionId,
      outcome: result.outcome.outcome,
      ...(result.outcome.outcome === "selected" ? { optionId: result.outcome.optionId } : {}),
    });
    return result;
  }

  private async resolvePermission(params: {
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
