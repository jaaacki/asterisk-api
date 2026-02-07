import { createServer } from "node:http";
import { loadConfig } from "./config.js";
import { CallManager } from "./call-manager.js";
import { AriConnection } from "./ari-connection.js";
import { createApi } from "./api.js";
import { attachWebSocketServer } from "./ws-server.js";
import { loadAllowlist, watchAllowlist } from "./allowlist.js";

async function main() {
  const config = loadConfig();

  // Load allowlist for inbound/outbound call filtering
  loadAllowlist();
  watchAllowlist();
  const callManager = new CallManager();
  const ariConn = new AriConnection(config, callManager);

  // Create Express app and HTTP server
  const app = createApi(config, ariConn, callManager);
  const server = createServer(app);

  // Attach WebSocket server for event streaming
  attachWebSocketServer(server, callManager);

  // Connect to Asterisk ARI
  await ariConn.connect();

  // Start HTTP server
  server.listen(config.api.port, config.api.host, () => {
    console.log(`[Server] Listening on ${config.api.host}:${config.api.port}`);
    console.log(`[Server] REST API: http://${config.api.host}:${config.api.port}`);
    console.log(`[Server] WebSocket: ws://${config.api.host}:${config.api.port}/events`);
  });

  // Graceful shutdown
  const shutdown = async () => {
    console.log("\n[Server] Shutting down...");
    await ariConn.disconnect();
    callManager.clearAllTimers();
    server.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
