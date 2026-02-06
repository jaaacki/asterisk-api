import express, { type Request, type Response, type NextFunction } from "express";
import type { Config } from "./config.js";
import type { AriConnection } from "./ari-connection.js";
import type { CallManager } from "./call-manager.js";

export function createApi(config: Config, ariConn: AriConnection, callManager: CallManager) {
  const app = express();
  app.use(express.json());

  // API key auth middleware
  if (config.api.apiKey) {
    app.use((req: Request, res: Response, next: NextFunction) => {
      const key = req.headers["x-api-key"] || req.query.api_key;
      if (key !== config.api.apiKey) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
      next();
    });
  }

  // Health check
  app.get("/health", (_req: Request, res: Response) => {
    res.json({
      status: "ok",
      ari: ariConn.isConnected(),
      activeCalls: callManager.listActive().length,
    });
  });

  // List active calls
  app.get("/calls", (_req: Request, res: Response) => {
    res.json({ calls: callManager.listActive() });
  });

  // Get call details
  app.get("/calls/:id", (req: Request, res: Response) => {
    const call = callManager.get(req.params.id);
    if (!call) {
      res.status(404).json({ error: "Call not found" });
      return;
    }
    res.json({ call });
  });

  // Originate a call
  app.post("/calls", async (req: Request, res: Response) => {
    try {
      const { endpoint, callerId, timeout, variables } = req.body;
      if (!endpoint) {
        res.status(400).json({ error: "endpoint is required" });
        return;
      }

      const call = await ariConn.originate({ endpoint, callerId, timeout, variables });
      res.status(201).json({ call });
    } catch (err: any) {
      console.error("[API] Originate error:", err);
      res.status(500).json({ error: err.message });
    }
  });

  // Play media on a call
  app.post("/calls/:id/play", async (req: Request, res: Response) => {
    try {
      const { media } = req.body;
      if (!media) {
        res.status(400).json({ error: "media is required (e.g. 'sound:hello-world')" });
        return;
      }

      await ariConn.playMedia(req.params.id, media);
      res.json({ status: "ok" });
    } catch (err: any) {
      console.error("[API] Play error:", err);
      res.status(err.message.includes("not found") ? 404 : 500).json({ error: err.message });
    }
  });

  // Start recording
  app.post("/calls/:id/record", async (req: Request, res: Response) => {
    try {
      const { name, format, maxDurationSeconds, beep } = req.body;
      const recordingName = await ariConn.startRecording(req.params.id, {
        name,
        format,
        maxDurationSeconds,
        beep,
      });
      res.status(201).json({ recordingName });
    } catch (err: any) {
      console.error("[API] Record error:", err);
      res.status(err.message.includes("not found") ? 404 : 500).json({ error: err.message });
    }
  });

  // Stop recording
  app.delete("/recordings/:name", async (req: Request, res: Response) => {
    try {
      await ariConn.stopRecording(req.params.name);
      res.json({ status: "stopped" });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Download recording
  app.get("/recordings/:name/file", async (req: Request, res: Response) => {
    try {
      const data = await ariConn.getRecording(req.params.name);
      res.set("Content-Type", "audio/wav");
      res.send(data);
    } catch (err: any) {
      res.status(404).json({ error: err.message });
    }
  });

  // Send DTMF
  app.post("/calls/:id/dtmf", async (req: Request, res: Response) => {
    try {
      const { dtmf } = req.body;
      if (!dtmf) {
        res.status(400).json({ error: "dtmf is required" });
        return;
      }
      await ariConn.sendDtmf(req.params.id, dtmf);
      res.json({ status: "ok" });
    } catch (err: any) {
      res.status(err.message.includes("not found") ? 404 : 500).json({ error: err.message });
    }
  });

  // Hang up a call
  app.delete("/calls/:id", async (req: Request, res: Response) => {
    try {
      await ariConn.hangup(req.params.id, req.body?.reason);
      res.json({ status: "hungup" });
    } catch (err: any) {
      res.status(err.message.includes("not found") ? 404 : 500).json({ error: err.message });
    }
  });

  return app;
}
