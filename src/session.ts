// AcpSessionHandle — bound-session sugar over AcpQuery.
//
// The SDK ships its own ergonomic wrapper (buildSession → ActiveSession with
// nextUpdate()/readText()), but it routes session/update notifications into a
// private per-wrapper queue — a SECOND consumer of the same stream acp-query's
// ClientApp handler already folds into the store. Wrapping it would mean two
// routes into client state (the store AND the queue) that can disagree. So
// acp-query deliberately does NOT wrap ActiveSession: the raw request path through
// AcpQuery stays the one canonical route into the store, and this handle is a
// zero-logic binding of that path to one sessionId — every call delegates to
// the same AcpQuery methods you could call directly.

import type { AcpQuery, SessionState, ToolCallState } from "./client.js";

export class AcpSessionHandle {
  constructor(
    private readonly q: AcpQuery,
    /** The bound session's id. */
    readonly sessionId: string,
  ) {}

  /** Current folded snapshot — `q.session(sessionId)`. */
  state(): SessionState | undefined {
    return this.q.session(this.sessionId);
  }

  /** The session's tool calls as an array (insertion order). */
  toolCalls(): ToolCallState[] {
    const s = this.state();
    return s ? Object.values(s.toolCalls) : [];
  }

  /** The session's slash commands — `q.commands(sessionId)`. */
  commands(): unknown[] | undefined {
    return this.q.commands(this.sessionId);
  }

  /** Notify on every state change — `q.subscribe(sessionId, fn)`. */
  subscribe(fn: () => void): () => void {
    return this.q.subscribe(this.sessionId, fn);
  }

  /** Send a prompt turn — `q.prompt(sessionId, text)`. */
  prompt(text: string): Promise<string> {
    return this.q.prompt(this.sessionId, text);
  }

  /** Cancel the current turn — `q.cancel(sessionId)`. */
  cancel(): Promise<void> {
    return this.q.cancel(this.sessionId);
  }

  /** Reload (replay) this session — `q.loadSession(sessionId, cwd)`. */
  load(cwd?: string): Promise<SessionState> {
    return this.q.loadSession(this.sessionId, cwd);
  }

  /**
   * The session's state changes as an async iterable of snapshots.
   *
   * Yields the current snapshot immediately (when one exists), then the
   * latest snapshot after each change — changes arriving while the consumer
   * is busy coalesce into one yield of the newest state (it is a fold, so the
   * latest snapshot subsumes the missed ones). The stream is endless by
   * design; `break` (or `return()`) unsubscribes:
   *
   * ```ts
   * const turn = h.prompt("go");
   * for await (const s of h.states()) {
   *   render(s);
   *   if (s.lastStopReason) break; // turn done
   * }
   * await turn;
   * ```
   */
  async *states(): AsyncGenerator<SessionState, void, void> {
    let wake: (() => void) | undefined;
    let dirty = false;
    const unsub = this.subscribe(() => {
      dirty = true;
      wake?.();
    });
    try {
      const first = this.state();
      if (first) yield first;
      for (;;) {
        if (!dirty) {
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
          wake = undefined;
        }
        dirty = false;
        const s = this.state();
        if (s) yield s;
      }
    } finally {
      unsub();
    }
  }
}
