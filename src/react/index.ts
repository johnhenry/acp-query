// @johnhenry/acp-query/react — thin React hooks over the acp-query store.
//
// Built on agent-query-core's react bindings (useCacheEntry /
// useInteractions), which in turn ride useSyncExternalStore — so the hooks
// inherit the store's guarantees: no resubscribe churn on inline keys, no
// re-render on structurally-equal rewrites, SSR-deterministic first paint.
//
// React is an OPTIONAL peer dependency: importing the root entrypoint never
// touches it; only this subpath does.

import { useMemo } from "react";
import { useCacheEntry, useInteractions } from "@johnhenry/agent-query-core/react";
import type { Interaction } from "@johnhenry/agent-query-core";
import type { AcpQuery, PermissionDecision, SessionState, ToolCallState } from "../client.js";

/**
 * One session's folded state, reactively: re-renders on every fold, returns
 * `undefined` for sessions the store hasn't seen.
 *
 * ```tsx
 * const state = useSession(q, sid);
 * return <pre>{state?.messageText}</pre>;
 * ```
 */
export function useSession(q: AcpQuery, sessionId: string): SessionState | undefined {
  const entry = useCacheEntry(q.cache, { kind: "session", id: sessionId });
  return entry?.data as SessionState | undefined;
}

const NO_TOOL_CALLS: ToolCallState[] = [];

/**
 * A session's tool calls as an array (insertion order), reactively. The array
 * identity is stable per fold (memoized on the snapshot), so it is safe in
 * dependency lists.
 */
export function useToolCalls(q: AcpQuery, sessionId: string): ToolCallState[] {
  const state = useSession(q, sessionId);
  return useMemo(() => (state ? Object.values(state.toolCalls) : NO_TOOL_CALLS), [state]);
}

/** What `usePermissions` returns: the pending queue + its resolver. */
export interface UsePermissionsResult {
  /** Pending broker interactions of type "permission" (the approval inbox). */
  permissions: Interaction[];
  /** Resolve one by id — typed over acp-query's PermissionDecision. */
  resolve: (id: number, decision: PermissionDecision) => void;
}

/**
 * The permission inbox, reactively: the broker's pending queue filtered to
 * type `"permission"` (fs/terminal gate interactions from `gateWrites` are
 * excluded — filter `q.interactions` yourself for those), plus the typed
 * resolver. With no broker configured, the queue is empty and `resolve` is a
 * no-op — acp-query is already fail-safe answering on its own.
 *
 * ```tsx
 * const { permissions, resolve } = usePermissions(q);
 * return permissions.map((p) => (
 *   <button key={p.id} onClick={() => resolve(p.id, { action: "approve" })}>allow</button>
 * ));
 * ```
 */
export function usePermissions(q: AcpQuery): UsePermissionsResult {
  const { interactions, resolve } = useInteractions<PermissionDecision>(q.interactions);
  return useMemo(
    () => ({ permissions: interactions.filter((i) => i.type === "permission"), resolve }),
    [interactions, resolve],
  );
}

// The core hooks compose with acp-query directly (useAuditLog(q.interactions),
// usePeerStatus(q.status), useCacheEntry(q.cache, key)) — re-exported so a
// React app needs a single import.
export {
  useAuditLog,
  useCacheEntry,
  useInteractions,
  usePeerStatus,
  useVersioned,
  AgentQueryDevtools,
} from "@johnhenry/agent-query-core/react";
