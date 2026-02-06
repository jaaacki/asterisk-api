import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "node:http";
import type { CallManager } from "./call-manager.js";
import type { CallEvent } from "./types.js";

/**
 * WebSocket server that streams call events to connected clients.
 * Clients connect to ws://host:port/events
 */
export function attachWebSocketServer(server: Server, callManager: CallManager) {
  const wss = new WebSocketServer({ server, path: "/events" });

  wss.on("connection", (ws) => {
    console.log("[WS] Client connected");

    // Send current active calls on connect
    ws.send(
      JSON.stringify({
        type: "snapshot",
        calls: callManager.listActive(),
        timestamp: new Date().toISOString(),
      })
    );

    ws.on("close", () => {
      console.log("[WS] Client disconnected");
    });
  });

  // Broadcast call events to all connected clients
  callManager.on("event", (event: CallEvent) => {
    const message = JSON.stringify({
      ...event,
      timestamp: event.timestamp.toISOString(),
    });

    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    }
  });

  return wss;
}
