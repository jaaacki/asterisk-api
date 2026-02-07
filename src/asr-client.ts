/**
 * ASR WebSocket Client
 * 
 * Connects to the ASR service WebSocket endpoint and streams audio frames
 * for real-time transcription.
 */

import { EventEmitter } from "node:events";
import WebSocket from "ws";

export interface AsrTranscription {
  text: string;
  is_partial: boolean;
  is_final: boolean;
}

export interface AsrClientOptions {
  /** ASR WebSocket URL */
  url: string;
  /** Reconnect delay in ms (default: 2000) */
  reconnectDelay?: number;
  /** Max reconnect attempts (default: 10, 0 = infinite) */
  maxReconnectAttempts?: number;
}

/**
 * ASR client for a single call session.
 * Manages WebSocket connection to ASR service and streams audio frames.
 */
export class AsrClient extends EventEmitter {
  private ws?: WebSocket;
  private reconnectTimer?: NodeJS.Timeout;
  private reconnectAttempts = 0;
  private closed = false;

  constructor(
    private callId: string,
    private options: AsrClientOptions,
    private log = console
  ) {
    super();
  }

  /**
   * Connect to ASR WebSocket endpoint.
   */
  async connect(): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.log.warn(`[AsrClient] Already connected for call ${this.callId}`);
      return;
    }

    this.closed = false;
    this.log.info(`[AsrClient] Connecting to ${this.options.url} for call ${this.callId}`);

    try {
      this.ws = new WebSocket(this.options.url);

      this.ws.on("open", () => {
        this.log.info(`[AsrClient] Connected to ASR service for call ${this.callId}`);
        this.reconnectAttempts = 0;
        this.emit("connected");
      });

      this.ws.on("message", (data: WebSocket.Data) => {
        try {
          // ASR sends JSON responses
          const message = JSON.parse(data.toString());

          if (message.status !== undefined) {
            // Status messages: {"status": "connected", ...} or {"status": "buffer_reset"}
            this.log.info(`[AsrClient] ASR status for call ${this.callId}: ${message.status}`);
          } else if (message.error !== undefined) {
            this.log.error(`[AsrClient] ASR error for call ${this.callId}: ${message.error}`);
          } else if (message.text !== undefined) {
            const transcription: AsrTranscription = {
              text: message.text,
              is_partial: message.is_partial ?? false,
              is_final: message.is_final ?? false,
            };

            this.log.info(
              `[AsrClient] Transcription for call ${this.callId}: "${transcription.text}" ` +
              `(partial: ${transcription.is_partial}, final: ${transcription.is_final})`
            );

            this.emit("transcription", transcription);
          } else {
            this.log.warn(`[AsrClient] Unexpected ASR message format:`, message);
          }
        } catch (err) {
          this.log.error(`[AsrClient] Failed to parse ASR message:`, err);
        }
      });

      this.ws.on("error", (err) => {
        this.log.error(`[AsrClient] WebSocket error for call ${this.callId}:`, err);
        this.emit("error", err);
      });

      this.ws.on("close", (code, reason) => {
        this.log.warn(
          `[AsrClient] WebSocket closed for call ${this.callId} (code: ${code}, reason: ${reason.toString()})`
        );
        this.emit("disconnected");
        
        // Auto-reconnect if not explicitly closed
        if (!this.closed) {
          this.scheduleReconnect();
        }
      });

      // Wait for connection to open
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error("ASR connection timeout"));
        }, 5000);

        this.ws!.once("open", () => {
          clearTimeout(timeout);
          resolve();
        });

        this.ws!.once("error", (err) => {
          clearTimeout(timeout);
          reject(err);
        });
      });
    } catch (err) {
      this.log.error(`[AsrClient] Failed to connect:`, err);
      throw err;
    }
  }

  /**
   * Send an audio frame to the ASR service.
   * @param audioData - Raw PCM audio buffer (16-bit, 16kHz, mono)
   */
  sendAudioFrame(audioData: Buffer): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.log.warn(`[AsrClient] Cannot send audio frame, WebSocket not open for call ${this.callId}`);
      return;
    }

    try {
      // Send binary PCM data directly
      this.ws.send(audioData);
    } catch (err) {
      this.log.error(`[AsrClient] Failed to send audio frame:`, err);
      this.emit("error", err);
    }
  }

  /**
   * Send a control command to the ASR service.
   * @param command - Control command ("flush" or "reset")
   */
  sendControl(command: "flush" | "reset"): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.log.warn(`[AsrClient] Cannot send control command, WebSocket not open for call ${this.callId}`);
      return;
    }

    try {
      // Send JSON control command (ASR server expects {"action": "..."})
      this.ws.send(JSON.stringify({ action: command }));
      this.log.info(`[AsrClient] Sent control command "${command}" for call ${this.callId}`);
    } catch (err) {
      this.log.error(`[AsrClient] Failed to send control command:`, err);
      this.emit("error", err);
    }
  }

  /**
   * Flush any buffered audio and get final transcription.
   */
  flush(): void {
    this.sendControl("flush");
  }

  /**
   * Reset the ASR session (clear all buffered state).
   */
  reset(): void {
    this.sendControl("reset");
  }

  /**
   * Close the ASR client connection.
   * Sends a flush and waits for the final transcription response before closing.
   */
  async close(): Promise<void> {
    this.closed = true;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.log.info(`[AsrClient] Flushing ASR before close for call ${this.callId}`);

      try {
        // Wait for is_final response after flush, with safety timeout
        await this.flushAndWait(2000);
      } catch (err) {
        this.log.warn(`[AsrClient] Flush before close failed for call ${this.callId}:`, err);
      }

      this.ws.close();
      this.ws = undefined;
    } else {
      // WebSocket already gone, just clean up
      this.ws = undefined;
    }
  }

  /**
   * Send flush and wait for the final transcription response.
   * @param timeoutMs - Safety timeout in ms (default: 2000)
   */
  private flushAndWait(timeoutMs = 2000): Promise<void> {
    return new Promise<void>((resolve) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        resolve();
        return;
      }

      const timeout = setTimeout(() => {
        this.log.warn(`[AsrClient] Flush response timeout (${timeoutMs}ms) for call ${this.callId}`);
        cleanup();
        resolve();
      }, timeoutMs);

      const onMessage = (data: WebSocket.Data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.is_final === true) {
            this.log.info(`[AsrClient] Final flush response received for call ${this.callId}`);
            // Still emit the transcription so it's captured
            if (msg.text !== undefined) {
              this.emit("transcription", {
                text: msg.text,
                is_partial: false,
                is_final: true,
              });
            }
            cleanup();
            resolve();
          }
        } catch {
          // Ignore parse errors during shutdown
        }
      };

      const onClose = () => {
        cleanup();
        resolve();
      };

      const cleanup = () => {
        clearTimeout(timeout);
        this.ws?.removeListener("message", onMessage);
        this.ws?.removeListener("close", onClose);
      };

      this.ws.on("message", onMessage);
      this.ws.on("close", onClose);

      // Send flush command
      try {
        this.ws.send(JSON.stringify({ action: "flush" }));
        this.log.info(`[AsrClient] Sent flush for call ${this.callId}, waiting for response...`);
      } catch {
        cleanup();
        resolve();
      }
    });
  }

  /**
   * Check if connected to ASR service.
   */
  isConnected(): boolean {
    return this.ws !== undefined && this.ws.readyState === WebSocket.OPEN;
  }

  /**
   * Schedule automatic reconnection after delay.
   */
  private scheduleReconnect(): void {
    const maxAttempts = this.options.maxReconnectAttempts ?? 10;
    
    if (maxAttempts > 0 && this.reconnectAttempts >= maxAttempts) {
      this.log.error(`[AsrClient] Max reconnect attempts (${maxAttempts}) reached for call ${this.callId}`);
      this.emit("max_reconnect_attempts");
      return;
    }

    if (this.reconnectTimer) {
      return; // Already scheduled
    }

    const delay = this.options.reconnectDelay ?? 2000;
    this.reconnectAttempts++;

    this.log.info(
      `[AsrClient] Scheduling reconnect attempt ${this.reconnectAttempts}/${maxAttempts || "∞"} ` +
      `in ${delay}ms for call ${this.callId}`
    );

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = undefined;
      
      try {
        await this.connect();
      } catch (err) {
        this.log.error(`[AsrClient] Reconnect failed:`, err);
        // Will trigger another reconnect via close event
      }
    }, delay);
  }
}

/**
 * ASR manager for managing multiple call ASR sessions.
 */
export class AsrManager extends EventEmitter {
  private clients = new Map<string, AsrClient>();

  constructor(
    private asrUrl: string,
    private log = console
  ) {
    super();
  }

  /**
   * Start ASR session for a call.
   */
  async startSession(callId: string): Promise<AsrClient> {
    if (this.clients.has(callId)) {
      throw new Error(`ASR session already exists for call ${callId}`);
    }

    const client = new AsrClient(
      callId,
      {
        url: this.asrUrl,
        reconnectDelay: 2000,
        maxReconnectAttempts: 10,
      },
      this.log
    );

    // Forward events
    client.on("connected", () => {
      this.emit("session.connected", { callId });
    });

    client.on("disconnected", () => {
      this.emit("session.disconnected", { callId });
    });

    client.on("transcription", (transcription: AsrTranscription) => {
      this.emit("transcription", { callId, transcription });
    });

    client.on("error", (error) => {
      this.emit("session.error", { callId, error });
    });

    client.on("max_reconnect_attempts", () => {
      this.log.warn(`[AsrManager] Max reconnect attempts reached for call ${callId}, ending session`);
      this.endSession(callId);
    });

    this.clients.set(callId, client);

    try {
      await client.connect();
      return client;
    } catch (err) {
      this.clients.delete(callId);
      throw err;
    }
  }

  /**
   * End ASR session for a call.
   */
  async endSession(callId: string): Promise<void> {
    const client = this.clients.get(callId);
    if (!client) {
      this.log.warn(`[AsrManager] No ASR session found for call ${callId}`);
      return;
    }

    await client.close();
    this.clients.delete(callId);
  }

  /**
   * Get ASR client for a call.
   */
  getClient(callId: string): AsrClient | undefined {
    return this.clients.get(callId);
  }

  /**
   * Check if ASR session exists for a call.
   */
  hasSession(callId: string): boolean {
    return this.clients.has(callId);
  }

  /**
   * End all ASR sessions.
   */
  async endAllSessions(): Promise<void> {
    const promises = Array.from(this.clients.values()).map((client) => client.close());
    await Promise.allSettled(promises);
    this.clients.clear();
  }
}
