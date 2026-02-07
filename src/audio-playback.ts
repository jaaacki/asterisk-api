/**
 * Audio Playback Module for Asterisk ARI
 *
 * Streams PCM audio into active calls via ExternalMedia WebSocket.
 * Mirrors the audio-capture.ts architecture (same ARI primitives, reverse direction):
 *
 *   TTS server → Node.js → WebSocket → ExternalMedia → Bridge → Call
 *
 * The ExternalMedia WebSocket is bidirectional — sending binary PCM frames
 * injects audio into the ExternalMedia channel. When bridged with the call
 * channel, the caller hears the audio.
 */

import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";

export interface AudioPlaybackOptions {
  /** Asterisk slin format (e.g. "slin16", "slin24") */
  format?: string;
  /** Sample rate in Hz (default: 16000) */
  sampleRate?: number;
}

/**
 * AudioPlayback manages a single streaming playback session on one call.
 */
export class AudioPlayback extends EventEmitter {
  private externalMediaChannelId?: string;
  private bridgeId?: string;
  private audioWs?: WebSocket;
  private active = false;
  private streaming = false;
  private streamTimer?: ReturnType<typeof setInterval>;
  private cancelled = false;

  constructor(
    private callId: string,
    private channelId: string,
    private ari: any,
    private options: AudioPlaybackOptions = {},
    private log = console,
    private ariWsUrl?: string,
    private ariAuth?: { username: string; password: string }
  ) {
    super();
  }

  /**
   * Create ExternalMedia channel, connect WebSocket, create bridge,
   * and add both call + ExternalMedia to the bridge.
   */
  async start(): Promise<void> {
    if (this.active) {
      throw new Error(`Playback already active for call ${this.callId}`);
    }

    const format = this.options.format || "slin16";
    this.log.info(`[AudioPlayback] Starting playback for call ${this.callId}, format=${format}`);

    try {
      // Step 1: Create ExternalMedia channel (server mode — Asterisk waits for WS client)
      const externalMediaId = `ttsplay-${randomUUID()}`;
      const externalMediaChannel = await this.ari.channels.externalMedia({
        channelId: externalMediaId,
        app: "openclaw-voice",
        format,
        transport: "websocket",
        encapsulation: "none",
        connection_type: "server",
        external_host: "",
      });

      this.externalMediaChannelId = externalMediaChannel.id;
      const wsConnectionId = externalMediaChannel.channelvars?.MEDIA_WEBSOCKET_CONNECTION_ID;

      this.log.info(
        `[AudioPlayback] Created ExternalMedia channel: ${this.externalMediaChannelId}` +
        (wsConnectionId ? `, wsConnectionId: ${wsConnectionId}` : "")
      );

      // Step 2: Connect WebSocket to ExternalMedia BEFORE bridging
      await this.connectWebSocket(wsConnectionId);

      // Step 3: Create mixing bridge
      const bridge = await this.ari.bridges.create({
        type: "mixing",
        name: `ttsplay-bridge-${this.callId}`,
      });
      this.bridgeId = bridge.id;
      this.log.info(`[AudioPlayback] Created bridge: ${bridge.id}`);

      // Step 4: Add both call channel and ExternalMedia to bridge
      await this.ari.bridges.addChannel({
        bridgeId: bridge.id,
        channel: [this.channelId, this.externalMediaChannelId],
      });

      this.log.info(`[AudioPlayback] Bridged call and ExternalMedia channels`);
      this.active = true;
      this.emit("started", { callId: this.callId });
    } catch (err: any) {
      this.log.error(`[AudioPlayback] Failed to start playback: ${err.message}`);
      await this.cleanup();
      throw err;
    }
  }

  /**
   * Stream raw PCM data into the call in real-time (~20ms chunks).
   * Returns a Promise that resolves when all audio has been sent.
   */
  async streamAudio(pcmData: Buffer, sampleRate: number): Promise<void> {
    if (!this.active || !this.audioWs || this.audioWs.readyState !== WebSocket.OPEN) {
      throw new Error("Playback not started or WebSocket not connected");
    }

    this.streaming = true;
    this.cancelled = false;

    // 20ms of audio at the given sample rate, 16-bit mono
    const bytesPerMs = (sampleRate * 2) / 1000; // 2 bytes per sample (16-bit)
    const chunkMs = 20;
    const chunkBytes = Math.floor(bytesPerMs * chunkMs);
    const totalChunks = Math.ceil(pcmData.length / chunkBytes);

    this.log.info(
      `[AudioPlayback] Streaming ${pcmData.length} bytes (${totalChunks} chunks × ${chunkMs}ms) for call ${this.callId}`
    );

    return new Promise<void>((resolve, reject) => {
      let chunkIndex = 0;

      const sendChunk = () => {
        if (this.cancelled) {
          this.streaming = false;
          resolve();
          return;
        }

        if (chunkIndex >= totalChunks) {
          // All chunks sent — wait one extra chunk period for drain
          if (this.streamTimer) {
            clearInterval(this.streamTimer);
            this.streamTimer = undefined;
          }
          setTimeout(() => {
            this.streaming = false;
            resolve();
          }, chunkMs);
          return;
        }

        const start = chunkIndex * chunkBytes;
        const end = Math.min(start + chunkBytes, pcmData.length);
        const chunk = pcmData.subarray(start, end);

        try {
          if (this.audioWs && this.audioWs.readyState === WebSocket.OPEN) {
            this.audioWs.send(chunk);
          } else {
            // WebSocket closed mid-stream
            if (this.streamTimer) {
              clearInterval(this.streamTimer);
              this.streamTimer = undefined;
            }
            this.streaming = false;
            resolve();
            return;
          }
        } catch (err: any) {
          if (this.streamTimer) {
            clearInterval(this.streamTimer);
            this.streamTimer = undefined;
          }
          this.streaming = false;
          reject(err);
          return;
        }

        chunkIndex++;
      };

      // Send first chunk immediately, then pace at 20ms intervals
      sendChunk();
      this.streamTimer = setInterval(sendChunk, chunkMs);
    });
  }

  /**
   * Stop playback — remove call from bridge, tear down bridge + ExternalMedia + WS.
   */
  async stop(): Promise<void> {
    if (!this.active) return;

    this.log.info(`[AudioPlayback] Stopping playback for call ${this.callId}`);
    this.cancelled = true;

    if (this.streamTimer) {
      clearInterval(this.streamTimer);
      this.streamTimer = undefined;
    }

    await this.cleanup();
    this.active = false;
    this.streaming = false;
    this.emit("stopped", { callId: this.callId });
  }

  /**
   * Abort mid-stream and tear down.
   */
  async cancel(): Promise<void> {
    this.cancelled = true;
    await this.stop();
  }

  isActive(): boolean {
    return this.active;
  }

  isStreaming(): boolean {
    return this.streaming;
  }

  private async connectWebSocket(wsConnectionId: string | undefined): Promise<void> {
    if (!this.ariWsUrl) {
      throw new Error("No ARI WebSocket URL provided for audio playback");
    }

    if (!wsConnectionId) {
      throw new Error("ExternalMedia channel did not return MEDIA_WEBSOCKET_CONNECTION_ID");
    }

    const wsUrl = this.ariWsUrl.replace(/^http/, "ws");
    const url = `${wsUrl}/media/${wsConnectionId}`;

    this.log.info(`[AudioPlayback] Connecting to ExternalMedia WebSocket: ${url}`);

    this.audioWs = new WebSocket(url, ["media"]);

    this.audioWs.on("error", (err) => {
      this.log.error(`[AudioPlayback] WebSocket error for call ${this.callId}:`, err);
      this.emit("error", { callId: this.callId, error: err });
    });

    this.audioWs.on("close", (code, reason) => {
      this.log.info(
        `[AudioPlayback] WebSocket closed for call ${this.callId} (code: ${code}, reason: ${reason.toString()})`
      );
    });

    this.audioWs.on("message", (data: Buffer | string) => {
      // ExternalMedia may send control messages or echo audio — ignore inbound
      if (!Buffer.isBuffer(data)) {
        const msg = data.toString();
        this.log.info(`[AudioPlayback] Control message: ${msg.substring(0, 200)}`);
      }
    });

    // Wait for connection to establish
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("ExternalMedia WebSocket connection timeout (5s)"));
      }, 5000);

      this.audioWs!.once("open", () => {
        clearTimeout(timeout);
        this.log.info(`[AudioPlayback] WebSocket connected for call ${this.callId}`);
        resolve();
      });

      this.audioWs!.once("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  private async cleanup(): Promise<void> {
    const promises: Promise<any>[] = [];

    // Close WebSocket
    if (this.audioWs) {
      try {
        this.audioWs.close();
      } catch (err) {
        this.log.warn(`[AudioPlayback] Failed to close WebSocket:`, err);
      }
      this.audioWs = undefined;
    }

    // Remove call channel from bridge (don't destroy the call itself)
    if (this.bridgeId) {
      promises.push(
        this.ari.bridges.removeChannel({ bridgeId: this.bridgeId, channel: this.channelId }).catch((err: any) => {
          this.log.warn(`[AudioPlayback] Failed to remove call from bridge: ${err.message}`);
        })
      );
    }

    // Destroy bridge
    if (this.bridgeId) {
      promises.push(
        this.ari.bridges.destroy({ bridgeId: this.bridgeId }).catch((err: any) => {
          this.log.warn(`[AudioPlayback] Failed to destroy bridge: ${err.message}`);
        })
      );
      this.bridgeId = undefined;
    }

    // Hangup ExternalMedia channel
    if (this.externalMediaChannelId) {
      promises.push(
        this.ari.channels.hangup({ channelId: this.externalMediaChannelId }).catch((err: any) => {
          this.log.warn(`[AudioPlayback] Failed to hangup ExternalMedia: ${err.message}`);
        })
      );
      this.externalMediaChannelId = undefined;
    }

    await Promise.allSettled(promises);
  }
}

/**
 * AudioPlaybackManager manages streaming playback for multiple calls.
 */
export class AudioPlaybackManager extends EventEmitter {
  private playbacks = new Map<string, AudioPlayback>();

  constructor(
    private ari: any,
    private log = console,
    private ariWsUrl?: string,
    private ariAuth?: { username: string; password: string }
  ) {
    super();
  }

  /**
   * Start a playback session for a call.
   * Returns the AudioPlayback instance (caller must call streamAudio() next).
   */
  async startPlayback(
    callId: string,
    channelId: string,
    options?: AudioPlaybackOptions
  ): Promise<AudioPlayback> {
    if (this.playbacks.has(callId)) {
      // Cancel existing playback before starting a new one
      await this.cancelPlayback(callId);
    }

    const playback = new AudioPlayback(
      callId,
      channelId,
      this.ari,
      options,
      this.log,
      this.ariWsUrl,
      this.ariAuth
    );

    // Forward events
    playback.on("started", (info) => {
      this.emit("playback.started", info);
    });

    playback.on("stopped", (info) => {
      this.emit("playback.finished", info);
      this.playbacks.delete(callId);
    });

    playback.on("error", (info) => {
      this.emit("playback.error", info);
    });

    this.playbacks.set(callId, playback);

    try {
      await playback.start();
      return playback;
    } catch (err) {
      this.playbacks.delete(callId);
      throw err;
    }
  }

  /**
   * Stop playback for a call (waits for clean teardown).
   */
  async stopPlayback(callId: string): Promise<void> {
    const playback = this.playbacks.get(callId);
    if (!playback) return;
    await playback.stop();
    this.playbacks.delete(callId);
  }

  /**
   * Cancel playback mid-stream for a call.
   */
  async cancelPlayback(callId: string): Promise<void> {
    const playback = this.playbacks.get(callId);
    if (!playback) return;
    await playback.cancel();
    this.playbacks.delete(callId);
  }

  hasPlayback(callId: string): boolean {
    return this.playbacks.has(callId);
  }

  /**
   * Stop all active playbacks (for shutdown).
   */
  async stopAll(): Promise<void> {
    const promises = Array.from(this.playbacks.values()).map((p) => p.cancel());
    await Promise.allSettled(promises);
    this.playbacks.clear();
  }
}
