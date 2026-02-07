/**
 * Audio Capture Module for Asterisk ARI
 * 
 * This module handles real-time audio capture from phone calls using:
 * 1. Snoop channel - mirrors audio from the active call channel
 * 2. ExternalMedia channel - streams audio via WebSocket/RTP to Node.js
 * 3. Audio processing - converts to PCM 16-bit, 16kHz mono, emits as frames
 */

import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import type { AudioCaptureConfig, AudioCaptureInfo, AudioFrame } from "./types.js";

export interface AudioCaptureOptions {
  /** Audio format for capture (default: slin16 = PCM 16-bit, 16kHz) */
  format?: string;
  /** Sample rate in Hz (default: 16000) */
  sampleRate?: number;
  /** Transport protocol (default: websocket) */
  transport?: "websocket" | "udp" | "tcp";
  /** Payload encapsulation (default: none for websocket) */
  encapsulation?: "rtp" | "audiosocket" | "none";
  /** Spy direction (default: in - capture incoming audio from caller) */
  spyDirection?: "none" | "both" | "out" | "in";
  /** ARI WebSocket URL for ExternalMedia connection */
  ariWsUrl?: string;
  /** ARI credentials for WebSocket authentication */
  ariAuth?: { username: string; password: string };
}

/**
 * AudioCapture manages audio streaming from a single call channel.
 */
export class AudioCapture extends EventEmitter {
  private snoopChannelId?: string;
  private externalMediaChannelId?: string;
  private active = false;
  private audioWs?: WebSocket;
  private bridgeId?: string;

  constructor(
    private callId: string,
    private channelId: string,
    private ari: any,
    private options: AudioCaptureOptions = {},
    private log = console
  ) {
    super();
  }

  /**
   * Start audio capture on the channel.
   * Creates a snoop channel and bridges it to an ExternalMedia channel.
   */
  async start(): Promise<AudioCaptureInfo> {
    if (this.active) {
      throw new Error(`Audio capture already active for call ${this.callId}`);
    }

    const format = this.options.format || "slin16"; // PCM 16-bit, 16kHz
    const sampleRate = this.options.sampleRate || 16000;
    const transport = this.options.transport || "websocket";
    const encapsulation = this.options.encapsulation || "none";
    const spyDirection = this.options.spyDirection || "in";

    this.log.info(`[AudioCapture] Starting capture for call ${this.callId}, channel ${this.channelId}`);

    try {
      // Step 1: Create snoop channel to monitor the active call
      const snoopId = `snoop-${randomUUID()}`;
      const snoopChannel = await this.ari.channels.snoopChannelWithId({
        channelId: this.channelId,
        snoopId,
        app: "openclaw-voice", // Same Stasis app
        spy: spyDirection, // Direction of audio to spy on ("in" = from caller)
        whisper: "none", // We're only listening, not injecting audio
      });

      this.snoopChannelId = snoopChannel.id;
      this.log.info(`[AudioCapture] Created snoop channel: ${this.snoopChannelId}`);

      // Step 2: Create ExternalMedia channel to stream audio out of Asterisk
      // For now, we'll use a simple approach: just create the channel
      // In a full implementation, you'd set up a WebSocket server or RTP listener
      // and pass the connection details here.
      
      // Note: ExternalMedia requires an external_host for client mode.
      // For server mode (websocket only), we can leave it empty and Asterisk
      // will wait for a WebSocket connection.
      
      const externalMediaId = `audiocap-${randomUUID()}`;
      
      // For WebSocket server mode (Asterisk waits for us to connect)
      const externalMediaChannel = await this.ari.channels.externalMedia({
        channelId: externalMediaId,
        app: "openclaw-voice",
        format,
        transport,
        encapsulation,
        connection_type: "server", // Asterisk acts as WebSocket server
        external_host: "", // Empty for server mode
      });

      this.externalMediaChannelId = externalMediaChannel.id;
      this.log.info(`[AudioCapture] Created ExternalMedia channel: ${this.externalMediaChannelId}`);

      // Step 3: Wait for ExternalMedia channel to enter Stasis before bridging
      // (race condition fix — addChannel fails if channel hasn't entered Stasis yet)
      await this.waitForStasisStart(externalMediaId, 5000);

      // Step 4: Create a bridge and connect snoop → ExternalMedia
      const bridge = await this.ari.bridges.create({
        type: "mixing",
        name: `audiocap-bridge-${this.callId}`,
      });

      this.bridgeId = bridge.id;
      this.log.info(`[AudioCapture] Created bridge: ${bridge.id}`);

      // Add both channels to the bridge
      await this.ari.bridges.addChannel({
        bridgeId: bridge.id,
        channel: [this.snoopChannelId, this.externalMediaChannelId],
      });

      this.log.info(`[AudioCapture] Bridged snoop and ExternalMedia channels`);

      // Step 5: Connect to ExternalMedia WebSocket to receive audio frames
      await this.connectToExternalMedia(externalMediaId, format, sampleRate);

      this.active = true;

      const captureInfo: AudioCaptureInfo = {
        enabled: true,
        snoopChannelId: this.snoopChannelId,
        externalMediaChannelId: this.externalMediaChannelId,
        format,
        sampleRate,
        startedAt: new Date(),
      };

      this.emit("started", captureInfo);

      return captureInfo;
    } catch (err: any) {
      this.log.error(`[AudioCapture] Failed to start capture: ${err.message}`);
      await this.cleanup();
      throw err;
    }
  }

  /**
   * Stop audio capture and clean up resources.
   */
  async stop(): Promise<void> {
    if (!this.active) {
      return;
    }

    this.log.info(`[AudioCapture] Stopping capture for call ${this.callId}`);
    await this.cleanup();
    this.active = false;
    this.emit("stopped");
  }

  /**
   * Check if audio capture is active.
   */
  isActive(): boolean {
    return this.active;
  }

  /**
   * Wait for a channel to enter Stasis (StasisStart event).
   * Resolves immediately if the channel is already in Stasis.
   */
  private waitForStasisStart(channelId: string, timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Timed out waiting for StasisStart on channel ${channelId}`));
      }, timeoutMs);

      const onStasisStart = (event: any, channel: any) => {
        if (channel.id === channelId) {
          this.log.info(`[AudioCapture] StasisStart received for ExternalMedia channel ${channelId}`);
          cleanup();
          resolve();
        }
      };

      const cleanup = () => {
        clearTimeout(timer);
        this.ari.removeListener("StasisStart", onStasisStart);
      };

      this.ari.on("StasisStart", onStasisStart);
    });
  }

  /**
   * Connect to Asterisk's ExternalMedia WebSocket to receive audio frames.
   */
  private async connectToExternalMedia(
    externalMediaId: string,
    format: string,
    sampleRate: number
  ): Promise<void> {
    if (!this.options.ariWsUrl || !this.options.ariAuth) {
      this.log.warn(
        `[AudioCapture] No ARI WebSocket URL or auth provided, skipping audio frame streaming for call ${this.callId}`
      );
      return;
    }

    // Build WebSocket URL for ExternalMedia channel
    // Format: ws://<host>:<port>/ari/events?app=<app>&api_key=<username>:<password>
    // For ExternalMedia, we connect to the channel's dedicated WebSocket endpoint
    const wsUrl = this.options.ariWsUrl.replace(/^http/, "ws");
    const auth = `${this.options.ariAuth.username}:${this.options.ariAuth.password}`;
    const url = `${wsUrl}/ari/externalMedia/${externalMediaId}?api_key=${auth}`;

    this.log.info(`[AudioCapture] Connecting to ExternalMedia WebSocket: ${url.replace(auth, "***")}`);

    try {
      this.audioWs = new WebSocket(url);

      this.audioWs.on("open", () => {
        this.log.info(`[AudioCapture] Connected to ExternalMedia WebSocket for call ${this.callId}`);
      });

      this.audioWs.on("message", (data: Buffer | string) => {
        // ExternalMedia sends binary audio frames (raw PCM)
        if (Buffer.isBuffer(data)) {
          const audioFrame: AudioFrame = {
            callId: this.callId,
            timestamp: Date.now(),
            data,
            format,
            sampleRate,
            channels: 1, // Mono
            sampleCount: data.length / 2, // 16-bit samples = 2 bytes each
          };

          // Emit frame event for processing
          this.emit("frame", audioFrame);
        } else {
          // Might be control messages or JSON
          this.log.debug(`[AudioCapture] Received non-binary message: ${data.toString().substring(0, 100)}`);
        }
      });

      this.audioWs.on("error", (err) => {
        this.log.error(`[AudioCapture] ExternalMedia WebSocket error for call ${this.callId}:`, err);
        this.emit("error", err);
      });

      this.audioWs.on("close", (code, reason) => {
        this.log.info(
          `[AudioCapture] ExternalMedia WebSocket closed for call ${this.callId} ` +
          `(code: ${code}, reason: ${reason.toString()})`
        );
      });

      // Wait for connection to establish
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error("ExternalMedia WebSocket connection timeout"));
        }, 5000);

        this.audioWs!.once("open", () => {
          clearTimeout(timeout);
          resolve();
        });

        this.audioWs!.once("error", (err) => {
          clearTimeout(timeout);
          reject(err);
        });
      });
    } catch (err) {
      this.log.error(`[AudioCapture] Failed to connect to ExternalMedia WebSocket:`, err);
      throw err;
    }
  }

  /**
   * Clean up snoop, ExternalMedia channels, and WebSocket.
   */
  private async cleanup(): Promise<void> {
    const promises: Promise<any>[] = [];

    // Close audio WebSocket
    if (this.audioWs) {
      this.log.info(`[AudioCapture] Closing ExternalMedia WebSocket for call ${this.callId}`);
      try {
        this.audioWs.close();
      } catch (err) {
        this.log.warn(`[AudioCapture] Failed to close WebSocket:`, err);
      }
      this.audioWs = undefined;
    }

    // Destroy bridge
    if (this.bridgeId) {
      this.log.info(`[AudioCapture] Destroying bridge: ${this.bridgeId}`);
      promises.push(
        this.ari.bridges.destroy({ bridgeId: this.bridgeId }).catch((err: any) => {
          this.log.warn(`[AudioCapture] Failed to destroy bridge: ${err.message}`);
        })
      );
      this.bridgeId = undefined;
    }

    if (this.snoopChannelId) {
      this.log.info(`[AudioCapture] Cleaning up snoop channel: ${this.snoopChannelId}`);
      promises.push(
        this.ari.channels.hangup({ channelId: this.snoopChannelId }).catch((err: any) => {
          this.log.warn(`[AudioCapture] Failed to hangup snoop channel: ${err.message}`);
        })
      );
      this.snoopChannelId = undefined;
    }

    if (this.externalMediaChannelId) {
      this.log.info(`[AudioCapture] Cleaning up ExternalMedia channel: ${this.externalMediaChannelId}`);
      promises.push(
        this.ari.channels.hangup({ channelId: this.externalMediaChannelId }).catch((err: any) => {
          this.log.warn(`[AudioCapture] Failed to hangup ExternalMedia channel: ${err.message}`);
        })
      );
      this.externalMediaChannelId = undefined;
    }

    await Promise.allSettled(promises);
  }
}

/**
 * AudioCaptureManager manages audio capture for multiple calls.
 */
export class AudioCaptureManager extends EventEmitter {
  private captures = new Map<string, AudioCapture>();

  constructor(
    private ari: any,
    private defaultOptions: AudioCaptureOptions = {},
    private log = console,
    private ariWsUrl?: string,
    private ariAuth?: { username: string; password: string }
  ) {
    super();
  }

  /**
   * Start audio capture for a call.
   */
  async startCapture(
    callId: string,
    channelId: string,
    options?: AudioCaptureOptions
  ): Promise<AudioCaptureInfo> {
    if (this.captures.has(callId)) {
      throw new Error(`Audio capture already exists for call ${callId}`);
    }

    const mergedOptions = {
      ...this.defaultOptions,
      ...options,
      ariWsUrl: this.ariWsUrl,
      ariAuth: this.ariAuth,
    };
    const capture = new AudioCapture(callId, channelId, this.ari, mergedOptions, this.log);

    // Forward events from individual captures
    capture.on("started", (info) => {
      this.emit("capture.started", { callId, info });
    });

    capture.on("stopped", () => {
      this.emit("capture.stopped", { callId });
      this.captures.delete(callId);
    });

    capture.on("frame", (frame: AudioFrame) => {
      this.emit("capture.frame", frame);
    });

    capture.on("error", (err) => {
      this.emit("capture.error", { callId, error: err });
    });

    this.captures.set(callId, capture);

    try {
      const info = await capture.start();
      return info;
    } catch (err) {
      this.captures.delete(callId);
      throw err;
    }
  }

  /**
   * Stop audio capture for a call.
   */
  async stopCapture(callId: string): Promise<void> {
    const capture = this.captures.get(callId);
    if (!capture) {
      this.log.warn(`[AudioCaptureManager] No active capture for call ${callId}`);
      return;
    }

    await capture.stop();
    this.captures.delete(callId);
  }

  /**
   * Check if audio capture is active for a call.
   */
  hasCapture(callId: string): boolean {
    return this.captures.has(callId);
  }

  /**
   * Get active capture for a call.
   */
  getCapture(callId: string): AudioCapture | undefined {
    return this.captures.get(callId);
  }

  /**
   * Stop all active captures.
   */
  async stopAll(): Promise<void> {
    const promises = Array.from(this.captures.values()).map((capture) => capture.stop());
    await Promise.allSettled(promises);
    this.captures.clear();
  }
}
