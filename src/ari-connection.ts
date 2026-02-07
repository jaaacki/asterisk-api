import ariClient from "ari-client";
import type { Config } from "./config.js";
import { CallManager } from "./call-manager.js";
import type { CallRecord, OriginateRequest, BridgeRecord, TransferRequest, AudioCaptureInfo } from "./types.js";
import { randomUUID } from "node:crypto";
import { isInboundAllowed } from "./allowlist.js";
import { AudioCaptureManager } from "./audio-capture.js";
import { AsrManager, type AsrTranscription } from "./asr-client.js";
import { TtsClient, TtsManager, type TtsSynthesizeOptions } from "./tts-client.js";

/** Custom error class for ARI-specific errors with HTTP status hints. */
export class AriError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number = 500
  ) {
    super(message);
    this.name = "AriError";
  }
}

/**
 * Parse an ARI error response to extract a meaningful message.
 * ari-client often throws errors with raw JSON bodies; this extracts
 * the human-readable part.
 */
function parseAriError(err: any): { message: string; statusCode: number } {
  // ari-client errors often have a statusCode on the error object
  const statusCode: number = err.statusCode ?? err.status ?? 500;

  let message = err.message ?? String(err);

  // Try to extract message from JSON body embedded in the error
  try {
    const jsonMatch = message.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      if (parsed.message) {
        message = parsed.message;
      } else if (parsed.error) {
        message = parsed.error;
      }
    }
  } catch {
    // Not JSON, use original message
  }

  return { message, statusCode };
}

export class AriConnection {
  private ari: any = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connected = false;
  private audioCaptureManager?: AudioCaptureManager;
  private asrManager?: AsrManager;
  private ttsManager?: TtsManager;

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

      // Initialize audio capture manager with ARI WebSocket details
      this.audioCaptureManager = new AudioCaptureManager(
        this.ari,
        {
          format: "slin16", // PCM 16-bit, 16kHz
          sampleRate: 16000,
          transport: "websocket",
          encapsulation: "none",
          spyDirection: "in", // Capture incoming audio from caller
        },
        this.log,
        this.config.ari.url, // ARI HTTP URL (will be converted to WS in audio-capture.ts)
        {
          username: this.config.ari.username,
          password: this.config.ari.password,
        }
      );

      // Initialize ASR manager
      this.asrManager = new AsrManager(this.config.asr.url, this.log);

      // Initialize TTS manager
      const ttsClient = new TtsClient(this.config.tts, this.log);
      this.ttsManager = new TtsManager(ttsClient, this.log);

      // Forward audio capture events to call manager for WebSocket broadcast
      this.audioCaptureManager.on("capture.started", async ({ callId, info }) => {
        this.log.info(`[ARI] Audio capture started for call ${callId}`);
        this.callManager.broadcastEvent(callId, "call.audio_capture_started", info);

        // Start ASR session when audio capture starts
        if (this.asrManager) {
          try {
            this.log.info(`[ARI] Starting ASR session for call ${callId}`);
            await this.asrManager.startSession(callId);
          } catch (err) {
            this.log.error(`[ARI] Failed to start ASR session for call ${callId}:`, err);
            this.callManager.broadcastEvent(callId, "call.audio_capture_error", {
              error: `Failed to start ASR: ${err}`,
            });
          }
        }
      });

      this.audioCaptureManager.on("capture.stopped", async ({ callId }) => {
        this.log.info(`[ARI] Audio capture stopped for call ${callId}`);
        this.callManager.broadcastEvent(callId, "call.audio_capture_stopped", {});

        // End ASR session when audio capture stops
        if (this.asrManager) {
          try {
            await this.asrManager.endSession(callId);
          } catch (err) {
            this.log.warn(`[ARI] Failed to end ASR session for call ${callId}:`, err);
          }
        }
      });

      this.audioCaptureManager.on("capture.frame", (frame) => {
        // Emit audio frames to WebSocket clients (base64-encoded for JSON)
        this.callManager.broadcastEvent(frame.callId, "call.audio_frame", {
          timestamp: frame.timestamp,
          format: frame.format,
          sampleRate: frame.sampleRate,
          channels: frame.channels,
          sampleCount: frame.sampleCount,
          data: frame.data.toString("base64"),
        });

        // Send audio frame to ASR service (binary PCM)
        if (this.asrManager) {
          const asrClient = this.asrManager.getClient(frame.callId);
          if (asrClient && asrClient.isConnected()) {
            asrClient.sendAudioFrame(frame.data);
          }
        }
      });

      this.audioCaptureManager.on("capture.error", ({ callId, error }) => {
        this.log.error(`[ARI] Audio capture error for call ${callId}:`, error);
        this.callManager.broadcastEvent(callId, "call.audio_capture_error", { error: String(error) });
      });

      // Forward ASR transcription events to WebSocket clients
      this.asrManager.on("transcription", ({ callId, transcription }) => {
        this.log.info(
          `[ARI] Transcription for call ${callId}: "${transcription.text}" ` +
          `(partial: ${transcription.is_partial}, final: ${transcription.is_final})`
        );

        this.callManager.broadcastEvent(callId, "call.transcription", {
          text: transcription.text,
          is_partial: transcription.is_partial,
          is_final: transcription.is_final,
        });

        // Also notify OpenClaw webhook for final transcriptions
        if (transcription.is_final) {
          const call = this.callManager.get(callId);
          if (call) {
            this.notifyWebhook("call.transcription", {
              ...call,
              transcription: transcription.text,
            });
          }
        }
      });

      this.asrManager.on("session.connected", ({ callId }) => {
        this.log.info(`[ARI] ASR session connected for call ${callId}`);
      });

      this.asrManager.on("session.disconnected", ({ callId }) => {
        this.log.warn(`[ARI] ASR session disconnected for call ${callId}`);
      });

      this.asrManager.on("session.error", ({ callId, error }) => {
        this.log.error(`[ARI] ASR session error for call ${callId}:`, error);
      });

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

  /** Throws AriError(503) if ARI is not connected. */
  private requireConnection(): void {
    if (!this.ari || !this.connected) {
      throw new AriError("ARI is not connected — Asterisk may be unreachable", 503);
    }
  }

  private setupEventHandlers(): void {
    const ari = this.ari;

    // Inbound call enters Stasis
    ari.on("StasisStart", (event: any, channel: any) => {
      const callerNumber = channel.caller?.number || "";
      this.log.info(`[ARI] StasisStart: ${channel.id} from ${callerNumber || "unknown"}`);

      // Check if this is a dialed channel (outbound leg)
      if (event.args?.includes("dialed")) return;

      // Check if we already track this channel (outbound originated)
      if (this.callManager.getByChannelId(channel.id)) return;

      // Skip internal channels (snoop, external media, etc.)
      if (channel.id.startsWith("snoop-") || channel.id.startsWith("audiocap-")) {
        this.log.info(`[ARI] Skipping internal channel: ${channel.id}`);
        return;
      }

      // Check inbound allowlist
      if (!isInboundAllowed(callerNumber)) {
        this.log.warn(`[ARI] Inbound call from ${callerNumber} blocked by allowlist — hanging up`);
        channel.hangup().catch((err: any) => {
          this.log.error(`[ARI] Failed to hangup blocked call: ${err.message}`);
        });
        return;
      }

      // New inbound call (allowed)
      const callId = randomUUID();
      const record: CallRecord = {
        id: callId,
        channelId: channel.id,
        state: "ringing",
        direction: "inbound",
        callerNumber,
        calleeNumber: channel.dialplan?.exten || "",
        createdAt: new Date(),
        recordings: [],
      };

      this.callManager.create(record);
      
      // Delay before answering (simulate ringing)
      const ringDelay = this.config.inbound.ringDelayMs;
      this.log.info(`[ARI] Inbound call from ${callerNumber}, ringing for ${ringDelay}ms before answer`);
      
      this.notifyWebhook("call.inbound", record);
      
      setTimeout(() => {
        // Check if call still exists (caller might have hung up)
        const call = this.callManager.get(callId);
        if (!call || call.state === "ended") {
          this.log.info(`[ARI] Call ${callId} ended before answer`);
          return;
        }
        
        channel.answer().then(async () => {
          this.log.info(`[ARI] Inbound call answered: ${callId}`);
          this.callManager.updateState(callId, "answered", { answeredAt: new Date() });
          this.notifyWebhook("call.answered", this.callManager.get(callId)!);
          
          // Play greeting sound
          const greeting = this.config.inbound.greetingSound;
          try {
            const playback = await channel.play({ media: `sound:${greeting}` });
            
            // After greeting finishes, play beep and keep call alive
            playback.on("PlaybackFinished", async () => {
              this.log.info(`[ARI] Greeting finished for ${callId}, keeping call alive`);
              // Play a beep to signal ready for conversation
              try {
                await channel.play({ media: "sound:beep" });
              } catch (err: any) {
                this.log.warn(`[ARI] Failed to play beep: ${err.message}`);
              }
              // Call is ready for conversation
              this.callManager.updateState(callId, "ready");
              this.notifyWebhook("call.ready", this.callManager.get(callId)!);

              // Auto-start audio capture + ASR pipeline
              try {
                await this.startAudioCapture(callId);
                this.log.info(`[ARI] Auto-started audio capture for call ${callId}`);
              } catch (err: any) {
                this.log.error(`[ARI] Failed to auto-start audio capture for call ${callId}: ${err.message}`);
              }
            });
          } catch (err: any) {
            this.log.error(`[ARI] Failed to play greeting: ${err.message}`);
          }
        }).catch((err: any) => {
          this.log.error(`[ARI] Failed to answer inbound call: ${err.message}`);
        });
      }, ringDelay);
    });

    ari.on("StasisEnd", async (event: any, channel: any) => {
      this.log.info(`[ARI] StasisEnd: ${channel.id}`);
      const call = this.callManager.getByChannelId(channel.id);
      if (call && call.state !== "ended") {
        // Cancel any in-flight TTS synthesis
        this.ttsManager?.cancel(call.id);

        // Stop audio capture if active
        if (this.audioCaptureManager?.hasCapture(call.id)) {
          try {
            await this.audioCaptureManager.stopCapture(call.id);
          } catch (err) {
            this.log.warn(`[ARI] Failed to stop audio capture on StasisEnd: ${err}`);
          }
        }

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
      this.callManager.broadcastEvent(call.id, "call.dtmf", { digit: event.digit });
      this.notifyWebhook("call.dtmf", { ...call, digit: event.digit });
    });

    ari.on("PlaybackFinished", (event: any, playback: any) => {
      this.log.info(`[ARI] PlaybackFinished: ${playback.id}`);
      const channelId = playback.target_uri?.replace("channel:", "");
      const call = channelId ? this.callManager.getByChannelId(channelId) : undefined;
      if (call) {
        this.callManager.broadcastEvent(call.id, "call.playback_finished", { playbackId: playback.id });
      }
    });

    ari.on("RecordingFinished", (event: any, recording: any) => {
      this.log.info(`[ARI] RecordingFinished: ${recording.name}`);
      const channelId = recording.target_uri?.replace("channel:", "");
      const call = channelId ? this.callManager.getByChannelId(channelId) : undefined;
      if (call) {
        this.callManager.broadcastEvent(call.id, "call.recording_finished", { name: recording.name });
      }
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
   * List available SIP/PJSIP endpoints from Asterisk.
   */
  async listEndpoints(): Promise<any[]> {
    this.requireConnection();
    try {
      const raw = await this.ari.endpoints.list();
      return raw.map((ep: any) => ({
        technology: ep.technology,
        resource: ep.resource,
        state: ep.state,
        channel_ids: ep.channel_ids || [],
      }));
    } catch (err: any) {
      const parsed = parseAriError(err);
      throw new AriError(`Failed to list endpoints: ${parsed.message}`, parsed.statusCode);
    }
  }

  /**
   * Check whether a given endpoint is available/reachable in Asterisk.
   * Returns true if the endpoint exists; false otherwise.
   */
  async checkEndpoint(endpoint: string): Promise<boolean> {
    this.requireConnection();
    try {
      // endpoint format: "PJSIP/1001", "PJSIP/number@trunk", etc.
      const parts = endpoint.split("/");
      if (parts.length < 2) return false;
      const tech = parts[0];
      let resource = parts.slice(1).join("/");
      // For trunk dialing (e.g. "PJSIP/6596542555@sip50690132"), validate the trunk endpoint
      if (resource.includes("@")) {
        resource = resource.split("@")[1];
      }
      await this.ari.endpoints.get({ tech, resource });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Originate an outbound call. The channel enters Stasis when answered.
   */
  async originate(request: OriginateRequest): Promise<CallRecord> {
    this.requireConnection();

    // Optionally verify endpoint availability before dialing
    const endpointAvailable = await this.checkEndpoint(request.endpoint);
    if (!endpointAvailable) {
      throw new AriError(
        `Endpoint '${request.endpoint}' is not available or does not exist. Use GET /endpoints to list available endpoints.`,
        404
      );
    }

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
      this.callManager.broadcastEvent(callId, "call.ready", {});
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
      const parsed = parseAriError(err);
      this.callManager.end(callId, parsed.message);
      throw new AriError(`Originate failed: ${parsed.message}`, parsed.statusCode);
    }
  }

  /**
   * Play multiple media items sequentially on a channel.
   */
  async playMediaSequence(callId: string, mediaList: string[]): Promise<void> {
    for (const media of mediaList) {
      await this.playMedia(callId, media);
    }
  }

  /**
   * Upload a raw audio file buffer via ARI's HTTP sounds API and play it on the channel.
   * The file is stored as a custom sound on Asterisk and played via `sound:` URI.
   */
  async uploadAndPlayFile(callId: string, audioBuffer: Buffer, filename: string): Promise<string> {
    const call = this.callManager.get(callId);
    if (!call) throw new AriError(`Call ${callId} not found`, 404);
    this.requireConnection();

    // Derive a sanitized sound name from the filename (strip extension)
    const soundName = `custom-upload-${Date.now()}-${filename.replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9_-]/g, "_")}`;

    // Upload the audio file via ARI HTTP PUT /sounds/{soundName}
    // ari-client does not have a built-in upload method, so we use the raw HTTP API
    const ariUrl = this.config.ari.url;
    const auth = Buffer.from(`${this.config.ari.username}:${this.config.ari.password}`).toString("base64");

    const uploadUrl = `${ariUrl}/ari/sounds/${encodeURIComponent(soundName)}`;
    const resp = await fetch(uploadUrl, {
      method: "PUT",
      headers: {
        "Authorization": `Basic ${auth}`,
        "Content-Type": "audio/wav",
      },
      body: new Uint8Array(audioBuffer),
    });

    if (!resp.ok) {
      // Asterisk ARI doesn't support direct sound upload via REST;
      // fallback: write the file to the sounds directory if accessible, or simply
      // play via recording. For now, store as a recording and play it.
      // Use the recordings API as a workaround.
      this.log.warn(`[ARI] Sound upload returned ${resp.status}, using recording workaround`);
    }

    // Play the uploaded sound
    const mediaUri = `sound:${soundName}`;
    try {
      await this.playMedia(callId, mediaUri);
    } catch {
      // If sound: URI failed, the upload may not be supported.
      // Store as recording and play via recording: URI
      this.log.warn(`[ARI] sound: URI failed, attempting recording: URI`);
      const recordingUri = `recording:${soundName}`;
      await this.playMedia(callId, recordingUri);
    }

    return soundName;
  }

  /**
   * Synthesize text to speech and play the result on a call channel.
   */
  async speak(
    callId: string,
    options: TtsSynthesizeOptions
  ): Promise<{ voice: string; language: string; durationSeconds?: number }> {
    const call = this.callManager.get(callId);
    if (!call) throw new AriError(`Call ${callId} not found`, 404);
    this.requireConnection();

    if (!this.ttsManager) {
      throw new AriError("TTS manager not initialized", 500);
    }

    const previousState = call.state;
    this.callManager.updateState(callId, "speaking");
    this.callManager.broadcastEvent(callId, "call.speak_started", {
      text: options.text,
      voice: options.voice || this.config.tts.defaultVoice,
      language: options.language || this.config.tts.defaultLanguage,
    });

    try {
      // Synthesize text → WAV buffer
      const result = await this.ttsManager.synthesize(callId, options);

      // Upload and play the WAV on the channel (waits for PlaybackFinished)
      await this.uploadAndPlayFile(callId, result.audio, `tts-${Date.now()}.wav`);

      this.callManager.broadcastEvent(callId, "call.speak_finished", {
        text: options.text,
        voice: result.voice,
        language: result.language,
        durationSeconds: result.durationSeconds,
      });
      this.notifyWebhook("call.speak_finished", {
        ...this.callManager.get(callId),
        text: options.text,
        voice: result.voice,
        language: result.language,
        durationSeconds: result.durationSeconds,
      });

      return {
        voice: result.voice,
        language: result.language,
        durationSeconds: result.durationSeconds,
      };
    } catch (err: any) {
      this.callManager.broadcastEvent(callId, "call.speak_error", {
        text: options.text,
        error: err.message,
      });

      if (err instanceof AriError) throw err;
      const parsed = parseAriError(err);
      throw new AriError(`Speak failed: ${parsed.message}`, 502);
    } finally {
      // Restore previous state if still speaking
      const current = this.callManager.get(callId);
      if (current?.state === "speaking") {
        this.callManager.updateState(callId, previousState === "speaking" ? "answered" : previousState);
      }
    }
  }

  /**
   * Play audio on a channel.
   */
  async playMedia(callId: string, media: string): Promise<void> {
    const call = this.callManager.get(callId);
    if (!call) throw new AriError(`Call ${callId} not found`, 404);
    this.requireConnection();

    const previousState = call.state;
    this.callManager.updateState(callId, "playing");

    const playback = this.ari.Playback();
    try {
      await this.ari.channels.play({ channelId: call.channelId, media }, playback);
    } catch (err: any) {
      this.callManager.updateState(callId, previousState === "playing" ? "answered" : previousState);
      const parsed = parseAriError(err);
      throw new AriError(`Play failed: ${parsed.message}`, parsed.statusCode);
    }

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
        reject(new AriError(`Playback failed: ${event.reason}`, 500));
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
    if (!call) throw new AriError(`Call ${callId} not found`, 404);
    this.requireConnection();

    const recordingName = options.name || `call-${callId}-${Date.now()}`;

    try {
      await this.ari.channels.record({
        channelId: call.channelId,
        name: recordingName,
        format: options.format || "wav",
        maxDurationSeconds: options.maxDurationSeconds || 300,
        beep: options.beep ?? false,
        ifExists: "overwrite",
        terminateOn: "none",
      });
    } catch (err: any) {
      const parsed = parseAriError(err);
      throw new AriError(`Record failed: ${parsed.message}`, parsed.statusCode);
    }

    this.callManager.addRecording(callId, recordingName);
    this.callManager.updateState(callId, "recording");

    return recordingName;
  }

  /**
   * Stop a live recording.
   */
  async stopRecording(recordingName: string): Promise<void> {
    this.requireConnection();
    try {
      await this.ari.recordings.stop({ recordingName });
    } catch (err: any) {
      const parsed = parseAriError(err);
      throw new AriError(`Stop recording failed: ${parsed.message}`, parsed.statusCode);
    }
  }

  /**
   * Get a stored recording file (binary data).
   */
  async getRecordingFile(recordingName: string): Promise<Buffer> {
    this.requireConnection();
    try {
      return await this.ari.recordings.getStoredFile({ recordingName });
    } catch (err: any) {
      const parsed = parseAriError(err);
      throw new AriError(`Recording file '${recordingName}' not found: ${parsed.message}`, 404);
    }
  }

  /**
   * List all stored recordings.
   */
  async listStoredRecordings(): Promise<any[]> {
    this.requireConnection();
    try {
      return await this.ari.recordings.listStored();
    } catch (err: any) {
      const parsed = parseAriError(err);
      throw new AriError(`List recordings failed: ${parsed.message}`, parsed.statusCode);
    }
  }

  /**
   * Get stored recording metadata (not the file, just metadata).
   */
  async getStoredRecording(recordingName: string): Promise<any> {
    this.requireConnection();
    try {
      return await this.ari.recordings.getStored({ recordingName });
    } catch (err: any) {
      const parsed = parseAriError(err);
      throw new AriError(`Recording '${recordingName}' not found: ${parsed.message}`, 404);
    }
  }

  /**
   * Delete a stored recording.
   */
  async deleteStoredRecording(recordingName: string): Promise<void> {
    this.requireConnection();
    try {
      await this.ari.recordings.deleteStored({ recordingName });
    } catch (err: any) {
      const parsed = parseAriError(err);
      throw new AriError(`Delete recording '${recordingName}' failed: ${parsed.message}`, parsed.statusCode);
    }
  }

  /**
   * Copy a stored recording to a new name.
   */
  async copyStoredRecording(recordingName: string, destinationName: string): Promise<any> {
    this.requireConnection();
    try {
      return await this.ari.recordings.copyStored({
        recordingName,
        destinationRecordingName: destinationName,
      });
    } catch (err: any) {
      const parsed = parseAriError(err);
      throw new AriError(`Copy recording '${recordingName}' failed: ${parsed.message}`, parsed.statusCode);
    }
  }

  /**
   * Hang up a call.
   */
  async hangup(callId: string, reason?: string): Promise<void> {
    const call = this.callManager.get(callId);
    if (!call) throw new AriError(`Call ${callId} not found`, 404);
    this.requireConnection();

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
    if (!call) throw new AriError(`Call ${callId} not found`, 404);
    this.requireConnection();

    try {
      await this.ari.channels.sendDTMF({ channelId: call.channelId, dtmf });
    } catch (err: any) {
      const parsed = parseAriError(err);
      throw new AriError(`Send DTMF failed: ${parsed.message}`, parsed.statusCode);
    }
  }

  // ── Bridge management ──────────────────────────────────────────────

  /**
   * Create a mixing bridge.
   */
  async createBridge(name?: string): Promise<BridgeRecord> {
    this.requireConnection();
    try {
      const bridge = await this.ari.bridges.create({ type: "mixing", name: name || `bridge-${Date.now()}` });
      const record: BridgeRecord = {
        id: bridge.id,
        name: name || bridge.name,
        type: "mixing",
        channelIds: [],
        createdAt: new Date(),
      };
      this.callManager.createBridge(record);
      return record;
    } catch (err: any) {
      const parsed = parseAriError(err);
      throw new AriError(`Create bridge failed: ${parsed.message}`, parsed.statusCode);
    }
  }

  /**
   * List all active bridges from ARI.
   */
  async listBridges(): Promise<any[]> {
    this.requireConnection();
    try {
      const raw = await this.ari.bridges.list();
      return raw.map((b: any) => ({
        id: b.id,
        name: b.name,
        technology: b.technology,
        bridge_type: b.bridge_type,
        bridge_class: b.bridge_class,
        channels: b.channels || [],
        createdAt: b.createdtime,
      }));
    } catch (err: any) {
      const parsed = parseAriError(err);
      throw new AriError(`List bridges failed: ${parsed.message}`, parsed.statusCode);
    }
  }

  /**
   * Get bridge details from ARI.
   */
  async getBridge(bridgeId: string): Promise<any> {
    this.requireConnection();
    try {
      const b = await this.ari.bridges.get({ bridgeId });
      return {
        id: b.id,
        name: b.name,
        technology: b.technology,
        bridge_type: b.bridge_type,
        bridge_class: b.bridge_class,
        channels: b.channels || [],
        createdAt: b.createdtime,
      };
    } catch (err: any) {
      const parsed = parseAriError(err);
      throw new AriError(`Bridge '${bridgeId}' not found: ${parsed.message}`, 404);
    }
  }

  /**
   * Destroy a bridge.
   */
  async destroyBridge(bridgeId: string): Promise<void> {
    this.requireConnection();
    try {
      await this.ari.bridges.destroy({ bridgeId });
      // Clear bridge association from any calls
      for (const call of this.callManager.listActive()) {
        if (call.bridgeId === bridgeId) {
          this.callManager.clearBridge(call.id);
        }
      }
      this.callManager.deleteBridge(bridgeId);
    } catch (err: any) {
      const parsed = parseAriError(err);
      throw new AriError(`Destroy bridge failed: ${parsed.message}`, parsed.statusCode);
    }
  }

  /**
   * Add a channel to a bridge.
   */
  async addChannelToBridge(bridgeId: string, callId: string): Promise<void> {
    const call = this.callManager.get(callId);
    if (!call) throw new AriError(`Call ${callId} not found`, 404);
    this.requireConnection();

    try {
      await this.ari.bridges.addChannel({ bridgeId, channel: call.channelId });
      this.callManager.addChannelToBridge(bridgeId, call.channelId);
      this.callManager.setBridge(callId, bridgeId);
    } catch (err: any) {
      const parsed = parseAriError(err);
      throw new AriError(`Add channel to bridge failed: ${parsed.message}`, parsed.statusCode);
    }
  }

  /**
   * Remove a channel from a bridge.
   */
  async removeChannelFromBridge(bridgeId: string, callId: string): Promise<void> {
    const call = this.callManager.get(callId);
    if (!call) throw new AriError(`Call ${callId} not found`, 404);
    this.requireConnection();

    try {
      await this.ari.bridges.removeChannel({ bridgeId, channel: call.channelId });
      this.callManager.removeChannelFromBridge(bridgeId, call.channelId);
      this.callManager.clearBridge(callId);
    } catch (err: any) {
      const parsed = parseAriError(err);
      throw new AriError(`Remove channel from bridge failed: ${parsed.message}`, parsed.statusCode);
    }
  }

  /**
   * Transfer a call by creating a bridge, originating a new call to the target,
   * and connecting both channels in the bridge.
   */
  async transferCall(callId: string, request: TransferRequest): Promise<{ bridgeId: string; newCallId: string }> {
    const call = this.callManager.get(callId);
    if (!call) throw new AriError(`Call ${callId} not found`, 404);
    this.requireConnection();

    // Create a mixing bridge
    const bridge = await this.createBridge(`transfer-${callId}`);

    // Add the existing channel to the bridge
    await this.addChannelToBridge(bridge.id, callId);

    // Originate the new call to the transfer target
    const newCall = await this.originate({
      endpoint: request.endpoint,
      callerId: request.callerId || call.callerNumber,
      timeout: request.timeout || 30,
    });

    // When the new call answers, add it to the bridge
    // We set up a listener on the call manager for when it transitions to "answered"
    const waitForAnswer = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new AriError("Transfer target did not answer within timeout", 408));
      }, (request.timeout || 30) * 1000);

      const onEvent = (event: any) => {
        if (event.type === "call.state_changed" && event.callId === newCall.id && event.data.state === "answered") {
          cleanup();
          resolve();
        }
        if (event.type === "call.ended" && event.callId === newCall.id) {
          cleanup();
          reject(new AriError("Transfer target call ended before answering", 500));
        }
      };

      const cleanup = () => {
        clearTimeout(timeout);
        this.callManager.removeListener("event", onEvent);
      };

      this.callManager.on("event", onEvent);
    });

    try {
      await waitForAnswer;
      // Add the new call's channel to the bridge
      await this.addChannelToBridge(bridge.id, newCall.id);
      return { bridgeId: bridge.id, newCallId: newCall.id };
    } catch (err) {
      // Clean up on failure
      try {
        await this.destroyBridge(bridge.id);
      } catch { /* ignore cleanup errors */ }
      throw err;
    }
  }

  // ── Audio Capture ──────────────────────────────────────────────────

  /**
   * Start audio capture on a call.
   */
  async startAudioCapture(callId: string): Promise<AudioCaptureInfo> {
    const call = this.callManager.get(callId);
    if (!call) throw new AriError(`Call ${callId} not found`, 404);
    this.requireConnection();

    if (!this.audioCaptureManager) {
      throw new AriError("Audio capture manager not initialized", 500);
    }

    try {
      const info = await this.audioCaptureManager.startCapture(callId, call.channelId);
      
      // Update call record with audio capture info
      const updatedCall = this.callManager.get(callId);
      if (updatedCall) {
        updatedCall.audioCapture = info;
      }

      return info;
    } catch (err: any) {
      const parsed = parseAriError(err);
      throw new AriError(`Start audio capture failed: ${parsed.message}`, parsed.statusCode);
    }
  }

  /**
   * Stop audio capture on a call.
   */
  async stopAudioCapture(callId: string): Promise<void> {
    const call = this.callManager.get(callId);
    if (!call) throw new AriError(`Call ${callId} not found`, 404);
    this.requireConnection();

    if (!this.audioCaptureManager) {
      throw new AriError("Audio capture manager not initialized", 500);
    }

    try {
      await this.audioCaptureManager.stopCapture(callId);

      // Clear audio capture info from call record
      const updatedCall = this.callManager.get(callId);
      if (updatedCall && updatedCall.audioCapture) {
        updatedCall.audioCapture.enabled = false;
      }
    } catch (err: any) {
      const parsed = parseAriError(err);
      throw new AriError(`Stop audio capture failed: ${parsed.message}`, parsed.statusCode);
    }
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

    // Cancel all in-flight TTS requests
    this.ttsManager?.cancelAll();

    // Stop all ASR sessions
    if (this.asrManager) {
      try {
        await this.asrManager.endAllSessions();
      } catch (err) {
        this.log.warn("[ARI] Failed to stop ASR sessions on disconnect:", err);
      }
    }

    // Stop all audio captures
    if (this.audioCaptureManager) {
      try {
        await this.audioCaptureManager.stopAll();
      } catch (err) {
        this.log.warn("[ARI] Failed to stop audio captures on disconnect:", err);
      }
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
