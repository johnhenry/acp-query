// Wire tap for stream transports — the acpq face of agent-query-core's
// instrumentTransport idea, shaped for the ACP SDK's Stream (a readable +
// writable of JSON-RPC messages) instead of an onmessage/send transport.
//
// Wrap the transport BEFORE q.connect() and every wire message — requests,
// responses, notifications, both directions — lands in the devtools sink as a
// compact `acp:wire` event alongside the semantic acp:* vocabulary. In-process
// `connect(agentApp)` has no stream to tap; this is for real transports
// (ndJsonStream over stdio, WebSocket, …).

import type { AnyMessage, Stream } from "@agentclientprotocol/sdk";
import type { DevtoolsSink } from "@johnhenry/agent-query-core";
import type { AcpDevtoolsEvent } from "./client.js";

/**
 * Returns a `Stream` that forwards to/from `stream` unchanged while emitting
 * one `{type: "acp:wire", dir, method?, id?}` event per message. `method` is
 * present on requests/notifications, `id` on requests/responses — so a
 * method-less event is a response, an id-less one a notification.
 *
 * ```ts
 * q.connect(instrumentAcpStream(ndJsonStream(proc.stdin, proc.stdout), hub));
 * ```
 */
export function instrumentAcpStream(
  stream: Stream,
  sink: DevtoolsSink<AcpDevtoolsEvent>,
): Stream {
  const tap = (dir: "in" | "out") =>
    new TransformStream<AnyMessage, AnyMessage>({
      transform(message, controller) {
        const m = message as { method?: string; id?: string | number };
        sink.emit({
          type: "acp:wire",
          dir,
          ...(typeof m.method === "string" ? { method: m.method } : {}),
          ...(m.id !== undefined ? { id: m.id } : {}),
        });
        controller.enqueue(message);
      },
    });
  const outgoing = tap("out");
  const incoming = tap("in");
  // Detached pipes: errors surface through the connection itself, not the tap.
  void outgoing.readable.pipeTo(stream.writable).catch(() => {});
  void stream.readable.pipeTo(incoming.writable).catch(() => {});
  return { writable: outgoing.writable, readable: incoming.readable };
}
