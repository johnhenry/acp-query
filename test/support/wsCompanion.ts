// A host "companion" for tests: serves an ACP agent over WebSocket and Streamable
// HTTP using the SDK's own experimental server + node adapter. Browser WebSockets
// cannot set headers, so auth here is a `?token=` query parameter checked at the
// upgrade, and the Origin header is checked against an allowlist.

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { AgentApp } from "@agentclientprotocol/sdk";
import { AcpServer } from "@agentclientprotocol/sdk/experimental/server";
import { createNodeHttpHandler, createNodeWebSocketUpgradeHandler } from "@agentclientprotocol/sdk/experimental/node";
import { WebSocketServer } from "ws";

export interface Companion {
  url: string;
  wsUrl: (token?: string) => string;
  rejected: string[];
  close(): Promise<void>;
}

export async function startCompanion(
  createAgent: () => AgentApp,
  opts: { token?: string; allowedOrigins?: string[] } = {},
): Promise<Companion> {
  const acp = new AcpServer({ createAgent });
  const wss = new WebSocketServer({ noServer: true });
  const http: Server = createServer(createNodeHttpHandler(acp));
  const upgrade = createNodeWebSocketUpgradeHandler(acp, wss);
  const rejected: string[] = [];
  http.on("upgrade", (req, socket, head) => {
    const u = new URL(req.url ?? "/", "http://x");
    if (opts.token && u.searchParams.get("token") !== opts.token) {
      rejected.push("token");
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    const origin = req.headers.origin;
    if (opts.allowedOrigins && origin && !opts.allowedOrigins.includes(origin)) {
      rejected.push("origin");
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
    upgrade(req, socket, head);
  });
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  const port = (http.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    wsUrl: (token) => `ws://127.0.0.1:${port}/${token ? `?token=${token}` : ""}`,
    rejected,
    close: async () => {
      await acp.close();
      wss.close();
      http.closeAllConnections();
      await new Promise<void>((r) => http.close(() => r()));
    },
  };
}
