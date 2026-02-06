import ariClient from "ari-client";
import type { Config } from "./config.js";
import { CallManager } from "./call-manager.js";
import type { CallRecord, OriginateRequest } from "./types.js";
import { randomUUID } from "node:crypto";

export class AriConnection {
  private ari: any = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connected = false;

  constructor(
    private config: Config,
    private callManager: CallManager,
    private log = console
  ) {}

  async connect(): Promise<void> {
    try {
      this.log.info(`[ARI] Connecting to ${this.config.ari.url}...`);
      this.ari = await ariClient.connect(
        this.config.ari.url,
        this.config.ari.username,
        this.config.ari.password
      );

      this.setupEventHandlers();
      this.ari.start(this.config.ari.app);
      this.connected = true;
      this.log.info(`[ARI] Connected. Stasis app: ${this.config.ari.app}`);
    } catch (err) {
      this.log.error("[ARI] Connection failed:", err);
      this.scheduleReconnect();
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  getClient(): any {
    return this.ari;
  }

  private setupEventHandlers(): void {
    const ari = this.ari;

    // Inbound call enters Stasis
    ari.on("StasisStart", (event: any, channel: any) => {
      this.log.info(`[ARI] StasisStart: ${channel.id} from ${channel.caller?.number || "unknown"}`);

      // Check if this is a dialed channel (outbound leg)
      if (event.args?.includes("dialed")) return;

      // Check if we already track this channel (outbound originated)
      if (this.callManager.getByChannelId(channel.id)) return;

      // New inbound call
      const callId = randomUUID();
      const record: CallRecord = {
        id: callId,
        channelId: channel.id,
        state: "answered",
        direction: "inbound",
        callerNumber: channel.caller?.number || "",
        calleeNumber: channel.dialplan?.exten || "",
        createdAt: new Date(),
        answeredAt: new Date(),
        recordings: [],
      };

      this.callManager.create(record);
      channel.answer();
      this.notifyWebhook("call.inbound", record);
    });

    ari.on("StasisEnd", (event: any, channel: any) => {
      this.log.info(`[ARI] StasisEnd: ${channel.id}`);
      const call = this.callManager.getByChannelId(channel.id);
      if (call && call.state !== "ended") {
        this.callManager.end(call.id, "normal");
        this.notifyWebhook("call.ended", call);
      }
    });

    ari.on("ChannelStateChange", (event: any, channel: any) => {
      const call = this.callManager.getByChannelId(channel.id);
      if (!call) return;

      this.log.info(`[ARI] ChannelStateChange: ${channel.id} -> ${channel.state}`);

      if (channel.state === "Up" && call.state === "ringing") {
        this.callManager.updateState(call.id, "answered", { answeredAt: new Date() });
        this.notifyWebhook("call.answered", call);
      }
    });

    ari.on("ChannelDtmfReceived", (event: any, channel: any) => {
      const call = this.callManager.getByChannelId(channel.id);
      if (!call) return;

      this.log.info(`[ARI] DTMF: ${event.digit} on ${call.id}`);
      this.notifyWebhook("call.dtmf", { ...call, digit: event.digit });
    });

    ari.on("PlaybackFinished", (event: any, playback: any) => {
      this.log.info(`[ARI] PlaybackFinished: ${playback.id}`);
    });

    ari.on("RecordingFinished", (event: any, recording: any) => {
      this.log.info(`[ARI] RecordingFinished: ${recording.name}`);
    });

    // WebSocket close = disconnected
    ari.on("WebSocketReconnecting", () => {
      this.log.warn("[ARI] WebSocket reconnecting...");
      this.connected = false;
    });

    ari.on("WebSocketConnected", () => {
      this.log.info("[ARI] WebSocket reconnected");
      this.connected = true;
    });
  }

  /**
   * Originate an outbound call. The channel enters Stasis when answered.
   */
  async originate(request: OriginateRequest): Promise<CallRecord> {
    if (!this.ari) throw new Error("ARI not connected");

    const callId = randomUUID();
    const channel = this.ari.Channel();

    const record: CallRecord = {
      id: callId,
      channelId: channel.id,
      state: "initiating",
      direction: "outbound",
      callerNumber: request.callerId || this.config.ari.app,
      calleeNumber: request.endpoint,
      createdAt: new Date(),
      recordings: [],
    };

    this.callManager.create(record);

    channel.on("ChannelStateChange", (event: any, ch: any) => {
      if (ch.state === "Ringing") {
        this.callManager.updateState(callId, "ringing");
      } else if (ch.state === "Up") {
        this.callManager.updateState(callId, "answered", { answeredAt: new Date() });
        this.notifyWebhook("call.answered", this.callManager.get(callId)!);
      }
    });

    channel.on("ChannelDestroyed", () => {
      const call = this.callManager.get(callId);
      if (call && call.state !== "ended") {
        this.callManager.end(callId, "hangup");
        this.notifyWebhook("call.ended", call);
      }
    });

    channel.on("StasisStart", async (event: any, ch: any) => {
      this.log.info(`[ARI] Outbound StasisStart: ${ch.id} for call ${callId}`);
      // Channel is now in our app, ready for media operations
      this.notifyWebhook("call.ready", this.callManager.get(callId)!);
    });

    try {
      await channel.originate({
        endpoint: request.endpoint,
        app: this.config.ari.app,
        callerId: request.callerId,
        timeout: request.timeout || 30,
        variables: request.variables ? { "CHANNEL(variables)": request.variables } : undefined,
      });

      this.callManager.updateState(callId, "ringing");
      return this.callManager.get(callId)!;
    } catch (err: any) {
      this.callManager.updateState(callId, "failed");
      this.callManager.end(callId, err.message);
      throw err;
    }
  }

  /**
   * Play audio on a channel.
   */
  async playMedia(callId: string, media: string): Promise<void> {
    const call = this.callManager.get(callId);
    if (!call) throw new Error(`Call ${callId} not found`);
    if (!this.ari) throw new Error("ARI not connected");

    const previousState = call.state;
    this.callManager.updateState(callId, "playing");

    const playback = this.ari.Playback();
    await this.ari.channels.play({ channelId: call.channelId, media }, playback);

    return new Promise<void>((resolve, reject) => {
      playback.on("PlaybackFinished", () => {
        // Restore previous state if still playing
        const current = this.callManager.get(callId);
        if (current?.state === "playing") {
          this.callManager.updateState(callId, previousState === "playing" ? "answered" : previousState);
        }
        resolve();
      });

      playback.on("PlaybackFailed", (event: any) => {
        this.callManager.updateState(callId, previousState === "playing" ? "answered" : previousState);
        reject(new Error(`Playback failed: ${event.reason}`));
      });
    });
  }

  /**
   * Start recording on a channel.
   */
  async startRecording(
    callId: string,
    options: { name?: string; format?: string; maxDurationSeconds?: number; beep?: boolean }
  ): Promise<string> {
    const call = this.callManager.get(callId);
    if (!call) throw new Error(`Call ${callId} not found`);
    if (!this.ari) throw new Error("ARI not connected");

    const recordingName = options.name || `call-${callId}-${Date.now()}`;

    await this.ari.channels.record({
      channelId: call.channelId,
      name: recordingName,
      format: options.format || "wav",
      maxDurationSeconds: options.maxDurationSeconds || 300,
      beep: options.beep ?? false,
      ifExists: "overwrite",
      terminateOn: "none",
    });

    this.callManager.addRecording(callId, recordingName);
    this.callManager.updateState(callId, "recording");

    return recordingName;
  }

  /**
   * Stop a live recording.
   */
  async stopRecording(recordingName: string): Promise<void> {
    if (!this.ari) throw new Error("ARI not connected");
    await this.ari.recordings.stop({ recordingName });
  }

  /**
   * Get a stored recording file.
   */
  async getRecording(recordingName: string): Promise<Buffer> {
    if (!this.ari) throw new Error("ARI not connected");
    return await this.ari.recordings.getStoredFile({ recordingName });
  }

  /**
   * Hang up a call.
   */
  async hangup(callId: string, reason?: string): Promise<void> {
    const call = this.callManager.get(callId);
    if (!call) throw new Error(`Call ${callId} not found`);
    if (!this.ari) throw new Error("ARI not connected");

    try {
      await this.ari.channels.hangup({ channelId: call.channelId, reason: reason || "normal" });
    } catch {
      // Channel may already be gone
    }
    this.callManager.end(callId, reason || "normal");
  }

  /**
   * Send DTMF tones on a channel.
   */
  async sendDtmf(callId: string, dtmf: string): Promise<void> {
    const call = this.callManager.get(callId);
    if (!call) throw new Error(`Call ${callId} not found`);
    if (!this.ari) throw new Error("ARI not connected");

    await this.ari.channels.sendDTMF({ channelId: call.channelId, dtmf });
  }

  /**
   * Notify OpenClaw plugin via webhook callback.
   */
  private async notifyWebhook(event: string, data: any): Promise<void> {
    const url = this.config.openclaw.webhookUrl;
    if (!url) return;

    try {
      await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event, data, timestamp: new Date().toISOString() }),
      });
    } catch (err) {
      this.log.warn(`[Webhook] Failed to notify ${url}:`, err);
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.log.info("[ARI] Reconnecting in 5s...");
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      await this.connect();
    }, 5000);
  }

  async disconnect(): Promise<void> {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ari) {
      try {
        this.ari.stop();
      } catch {
        // ignore
      }
      this.ari = null;
      this.connected = false;
    }
  }
}
