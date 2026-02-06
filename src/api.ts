import express, { type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import type { Config } from "./config.js";
import { AriConnection, AriError } from "./ari-connection.js";
import type { CallManager } from "./call-manager.js";

// ── Zod request body schemas ────────────────────────────────────────────

const OriginateRequestSchema = z.object({
  endpoint: z.string().min(1, "endpoint is required (e.g. 'PJSIP/1001')"),
  callerId: z.string().optional(),
  timeout: z.number().int().min(1).max(120).optional(),
  variables: z.record(z.string()).optional(),
});

const PlayRequestSchema = z.object({
  media: z.union([
    z.string().min(1, "media is required (e.g. 'sound:hello-world')"),
    z.array(z.string().min(1)).min(1, "media array must have at least one item"),
  ]),
});

const RecordRequestSchema = z.object({
  name: z.string().optional(),
  format: z.enum(["wav", "gsm", "ulaw", "alaw", "sln", "sln16"]).optional(),
  maxDurationSeconds: z.number().int().min(1).max(7200).optional(),
  beep: z.boolean().optional(),
});

const DtmfRequestSchema = z.object({
  dtmf: z.string().min(1, "dtmf is required").regex(/^[0-9A-D*#]+$/i, "dtmf must contain valid DTMF characters (0-9, A-D, *, #)"),
});

const HangupRequestSchema = z.object({
  reason: z.string().optional(),
}).optional();

const CreateBridgeRequestSchema = z.object({
  name: z.string().optional(),
}).optional();

const BridgeChannelRequestSchema = z.object({
  callId: z.string().min(1, "callId is required"),
});

const TransferRequestSchema = z.object({
  endpoint: z.string().min(1, "endpoint is required (e.g. 'PJSIP/1001')"),
  callerId: z.string().optional(),
  timeout: z.number().int().min(1).max(120).optional(),
});

const CopyRecordingRequestSchema = z.object({
  destinationName: z.string().min(1, "destinationName is required"),
});

// ── Helpers ─────────────────────────────────────────────────────────────

/** Map an error to the appropriate HTTP status + JSON body. */
function errorResponse(res: Response, err: unknown): void {
  if (err instanceof AriError) {
    res.status(err.statusCode).json({ error: err.message });
    return;
  }

  if (err instanceof z.ZodError) {
    const messages = err.errors.map((e) => `${e.path.join(".")}: ${e.message}`);
    res.status(400).json({ error: "Validation failed", details: messages });
    return;
  }

  const message = err instanceof Error ? err.message : String(err);
  res.status(500).json({ error: message });
}

// ── API factory ─────────────────────────────────────────────────────────

export function createApi(config: Config, ariConn: AriConnection, callManager: CallManager) {
  const app = express();
  app.use(express.json());

  // API key auth middleware (skip for GET / overview)
  if (config.api.apiKey) {
    app.use((req: Request, res: Response, next: NextFunction) => {
      // Allow unauthenticated access to API overview
      if (req.path === "/" && req.method === "GET") return next();

      const key = req.headers["x-api-key"] || req.query.api_key;
      if (key !== config.api.apiKey) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
      next();
    });
  }

  // ── GET / — API overview ───────────────────────────────────────────

  app.get("/", (_req: Request, res: Response) => {
    res.json({
      name: "asterisk-api",
      description: "REST API bridge between OpenClaw and Asterisk/FreePBX via ARI",
      endpoints: {
        "GET  /": "This overview",
        "GET  /health": "Health check (ARI connection status, active call count)",
        "GET  /endpoints": "List available SIP/PJSIP endpoints from Asterisk",
        "GET  /calls": "List active calls",
        "GET  /calls/:id": "Get call details",
        "POST /calls": "Originate an outbound call { endpoint, callerId?, timeout?, variables? }",
        "DELETE /calls/:id": "Hang up a call { reason? }",
        "POST /calls/:id/play": "Play audio on a call { media } (string or array for sequential playback)",
        "POST /calls/:id/play/file": "Upload raw WAV audio and play it (Content-Type: audio/wav, body = raw bytes)",
        "POST /calls/:id/record": "Start recording { name?, format?, maxDurationSeconds?, beep? }",
        "POST /calls/:id/dtmf": "Send DTMF tones { dtmf }",
        "POST /calls/:id/transfer": "Transfer call to endpoint { endpoint, callerId?, timeout? }",
        "POST /bridges": "Create a mixing bridge { name? }",
        "GET  /bridges": "List all bridges",
        "GET  /bridges/:id": "Get bridge details",
        "DELETE /bridges/:id": "Destroy a bridge",
        "POST /bridges/:id/addChannel": "Add a call to a bridge { callId }",
        "POST /bridges/:id/removeChannel": "Remove a call from a bridge { callId }",
        "GET  /recordings": "List all stored recordings",
        "GET  /recordings/:name": "Get recording metadata",
        "GET  /recordings/:name/file": "Download a stored recording (audio/wav)",
        "POST /recordings/:name/copy": "Copy a stored recording { destinationName }",
        "DELETE /recordings/:name": "Stop live recording, or delete stored (?stored=true)",
        "WS   /events": "WebSocket stream of real-time call events",
      },
    });
  });

  // ── GET /health ────────────────────────────────────────────────────

  app.get("/health", (_req: Request, res: Response) => {
    res.json({
      status: "ok",
      ari: ariConn.isConnected(),
      activeCalls: callManager.listActive().length,
    });
  });

  // ── GET /endpoints — list SIP endpoints ────────────────────────────

  app.get("/endpoints", async (_req: Request, res: Response) => {
    try {
      const endpoints = await ariConn.listEndpoints();
      res.json({ endpoints });
    } catch (err: unknown) {
      console.error("[API] List endpoints error:", err);
      errorResponse(res, err);
    }
  });

  // ── GET /calls — list active calls ─────────────────────────────────

  app.get("/calls", (_req: Request, res: Response) => {
    res.json({ calls: callManager.listActive() });
  });

  // ── GET /calls/:id ─────────────────────────────────────────────────

  app.get("/calls/:id", (req: Request, res: Response) => {
    const call = callManager.get(req.params.id);
    if (!call) {
      res.status(404).json({ error: "Call not found" });
      return;
    }
    res.json({ call });
  });

  // ── POST /calls — originate ────────────────────────────────────────

  app.post("/calls", async (req: Request, res: Response) => {
    try {
      const body = OriginateRequestSchema.parse(req.body);
      const call = await ariConn.originate(body);
      res.status(201).json({ call });
    } catch (err: unknown) {
      console.error("[API] Originate error:", err);
      errorResponse(res, err);
    }
  });

  // ── POST /calls/:id/play — play media (single or sequence) ────────

  app.post("/calls/:id/play", async (req: Request, res: Response) => {
    try {
      const body = PlayRequestSchema.parse(req.body);
      if (Array.isArray(body.media)) {
        await ariConn.playMediaSequence(req.params.id, body.media);
      } else {
        await ariConn.playMedia(req.params.id, body.media);
      }
      res.json({ status: "ok" });
    } catch (err: unknown) {
      console.error("[API] Play error:", err);
      errorResponse(res, err);
    }
  });

  // ── POST /calls/:id/play/file — upload and play raw audio file ───

  app.post(
    "/calls/:id/play/file",
    express.raw({ type: ["audio/wav", "audio/x-wav", "audio/wave", "audio/l16", "application/octet-stream"], limit: "10mb" }),
    async (req: Request, res: Response) => {
      try {
        const audioBuffer = req.body as Buffer;
        if (!audioBuffer || !Buffer.isBuffer(audioBuffer) || audioBuffer.length === 0) {
          res.status(400).json({
            error: "Request body must be raw audio data. Set Content-Type to audio/wav and send the file as the request body.",
          });
          return;
        }

        // Derive filename from Content-Disposition header or use a default
        const disposition = req.headers["content-disposition"];
        let filename = "upload.wav";
        if (disposition) {
          const match = disposition.match(/filename="?([^";]+)"?/);
          if (match) filename = match[1];
        }

        const soundName = await ariConn.uploadAndPlayFile(req.params.id, audioBuffer, filename);
        res.json({ status: "ok", soundName });
      } catch (err: unknown) {
        console.error("[API] Play file error:", err);
        errorResponse(res, err);
      }
    }
  );

  // ── POST /calls/:id/record — start recording ──────────────────────

  app.post("/calls/:id/record", async (req: Request, res: Response) => {
    try {
      const body = RecordRequestSchema.parse(req.body);
      const recordingName = await ariConn.startRecording(req.params.id, body);
      res.status(201).json({ recordingName });
    } catch (err: unknown) {
      console.error("[API] Record error:", err);
      errorResponse(res, err);
    }
  });

  // ── Recording management routes ────────────────────────────────────

  // GET /recordings — list all stored recordings
  app.get("/recordings", async (_req: Request, res: Response) => {
    try {
      const recordings = await ariConn.listStoredRecordings();
      res.json({ recordings });
    } catch (err: unknown) {
      errorResponse(res, err);
    }
  });

  // GET /recordings/:name — get recording metadata
  app.get("/recordings/:name", async (req: Request, res: Response) => {
    try {
      const recording = await ariConn.getStoredRecording(req.params.name);
      res.json({ recording });
    } catch (err: unknown) {
      errorResponse(res, err);
    }
  });

  // GET /recordings/:name/file — download stored recording
  app.get("/recordings/:name/file", async (req: Request, res: Response) => {
    try {
      const data = await ariConn.getRecordingFile(req.params.name);
      res.set("Content-Type", "audio/wav");
      res.send(data);
    } catch (err: unknown) {
      errorResponse(res, err);
    }
  });

  // POST /recordings/:name/copy — copy a stored recording
  app.post("/recordings/:name/copy", async (req: Request, res: Response) => {
    try {
      const body = CopyRecordingRequestSchema.parse(req.body);
      const result = await ariConn.copyStoredRecording(req.params.name, body.destinationName);
      res.status(201).json({ recording: result });
    } catch (err: unknown) {
      errorResponse(res, err);
    }
  });

  // DELETE /recordings/:name — stop a live recording or delete a stored recording
  app.delete("/recordings/:name", async (req: Request, res: Response) => {
    try {
      const { stored } = req.query;
      if (stored === "true") {
        // Delete a stored recording
        await ariConn.deleteStoredRecording(req.params.name);
        res.json({ status: "deleted" });
      } else {
        // Stop a live recording (original behavior)
        await ariConn.stopRecording(req.params.name);
        res.json({ status: "stopped" });
      }
    } catch (err: unknown) {
      errorResponse(res, err);
    }
  });

  // ── POST /calls/:id/dtmf — send DTMF ─────────────────────────────

  app.post("/calls/:id/dtmf", async (req: Request, res: Response) => {
    try {
      const body = DtmfRequestSchema.parse(req.body);
      await ariConn.sendDtmf(req.params.id, body.dtmf);
      res.json({ status: "ok" });
    } catch (err: unknown) {
      console.error("[API] DTMF error:", err);
      errorResponse(res, err);
    }
  });

  // ── POST /calls/:id/transfer — transfer a call ─────────────────────

  app.post("/calls/:id/transfer", async (req: Request, res: Response) => {
    try {
      const body = TransferRequestSchema.parse(req.body);
      const result = await ariConn.transferCall(req.params.id, body);
      res.status(201).json(result);
    } catch (err: unknown) {
      console.error("[API] Transfer error:", err);
      errorResponse(res, err);
    }
  });

  // ── DELETE /calls/:id — hang up ────────────────────────────────────

  app.delete("/calls/:id", async (req: Request, res: Response) => {
    try {
      const body = HangupRequestSchema.parse(req.body);
      await ariConn.hangup(req.params.id, body?.reason);
      res.json({ status: "hungup" });
    } catch (err: unknown) {
      errorResponse(res, err);
    }
  });

  // ── Bridge routes ─────────────────────────────────────────────────

  // POST /bridges — create a mixing bridge
  app.post("/bridges", async (req: Request, res: Response) => {
    try {
      const body = CreateBridgeRequestSchema.parse(req.body);
      const bridge = await ariConn.createBridge(body?.name);
      res.status(201).json({ bridge });
    } catch (err: unknown) {
      console.error("[API] Create bridge error:", err);
      errorResponse(res, err);
    }
  });

  // GET /bridges — list bridges
  app.get("/bridges", async (_req: Request, res: Response) => {
    try {
      const bridges = await ariConn.listBridges();
      const tracked = callManager.listBridges();
      res.json({ bridges, tracked });
    } catch (err: unknown) {
      errorResponse(res, err);
    }
  });

  // GET /bridges/:id — get bridge details
  app.get("/bridges/:id", async (req: Request, res: Response) => {
    try {
      const bridge = await ariConn.getBridge(req.params.id);
      const tracked = callManager.getBridge(req.params.id);
      res.json({ bridge, tracked });
    } catch (err: unknown) {
      errorResponse(res, err);
    }
  });

  // DELETE /bridges/:id — destroy a bridge
  app.delete("/bridges/:id", async (req: Request, res: Response) => {
    try {
      await ariConn.destroyBridge(req.params.id);
      res.json({ status: "destroyed" });
    } catch (err: unknown) {
      errorResponse(res, err);
    }
  });

  // POST /bridges/:id/addChannel — add a call's channel to a bridge
  app.post("/bridges/:id/addChannel", async (req: Request, res: Response) => {
    try {
      const body = BridgeChannelRequestSchema.parse(req.body);
      await ariConn.addChannelToBridge(req.params.id, body.callId);
      res.json({ status: "ok" });
    } catch (err: unknown) {
      errorResponse(res, err);
    }
  });

  // POST /bridges/:id/removeChannel — remove a call's channel from a bridge
  app.post("/bridges/:id/removeChannel", async (req: Request, res: Response) => {
    try {
      const body = BridgeChannelRequestSchema.parse(req.body);
      await ariConn.removeChannelFromBridge(req.params.id, body.callId);
      res.json({ status: "ok" });
    } catch (err: unknown) {
      errorResponse(res, err);
    }
  });

  return app;
}
