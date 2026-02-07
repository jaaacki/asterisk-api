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
}

/**
 * AudioCapture manages audio streaming from a single call channel.
 */
export class AudioCapture extends EventEmitter {
  private snoopChannelId?: string;
  private externalMediaChannelId?: string;
  private active = false;

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

      // Step 3: Create a bridge and connect snoop → ExternalMedia
      const bridge = await this.ari.bridges.create({
        type: "mixing",
        name: `audiocap-bridge-${this.callId}`,
      });

      this.log.info(`[AudioCapture] Created bridge: ${bridge.id}`);

      // Add both channels to the bridge
      await this.ari.bridges.addChannel({
        bridgeId: bridge.id,
        channel: [this.snoopChannelId, this.externalMediaChannelId],
      });

      this.log.info(`[AudioCapture] Bridged snoop and ExternalMedia channels`);

      this.active = true;

      const captureInfo: AudioCaptureInfo = {
        enabled: true,
        snoopChannelId: this.snoopChannelId,
        externalMediaChannelId: this.externalMediaChannelId,
        format,
        sampleRate,
        startedAt: new Date(),
      };

      // In a full implementation, you would:
      // 1. Connect to the Asterisk WebSocket endpoint for the ExternalMedia channel
      // 2. Receive audio frames from the WebSocket
      // 3. Process and emit them as AudioFrame events
      // For now, we'll emit a placeholder event
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
   * Clean up snoop and ExternalMedia channels.
   */
  private async cleanup(): Promise<void> {
    const promises: Promise<any>[] = [];

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
    private log = console
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

    const mergedOptions = { ...this.defaultOptions, ...options };
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
