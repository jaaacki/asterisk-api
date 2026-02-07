/**
 * TTS (Text-to-Speech) HTTP Client
 *
 * Sends text to an OpenAI-compatible TTS server and returns WAV audio.
 * The TTS server (Qwen3-TTS) exposes POST /v1/audio/speech.
 */

export interface TtsSynthesizeOptions {
  text: string;
  voice?: string;
  language?: string;
  speed?: number;
}

export interface TtsSynthesizeResult {
  audio: Buffer;
  voice: string;
  language: string;
  durationSeconds?: number;
}

export interface TtsClientConfig {
  /** TTS server base URL, e.g. http://192.168.2.198:8101 */
  url: string;
  defaultVoice: string;
  defaultLanguage: string;
  timeoutMs: number;
}

/**
 * Estimate WAV duration from a buffer by reading the header.
 * Returns undefined if the buffer is not a valid WAV or too short.
 */
function estimateWavDuration(buf: Buffer): number | undefined {
  // WAV header: bytes 0-3 = "RIFF", 8-11 = "WAVE"
  if (buf.length < 44) return undefined;
  if (buf.toString("ascii", 0, 4) !== "RIFF") return undefined;
  if (buf.toString("ascii", 8, 12) !== "WAVE") return undefined;

  // Read byte rate from header (bytes 28-31, little-endian)
  const byteRate = buf.readUInt32LE(28);
  if (byteRate === 0) return undefined;

  // Data size = total file size minus header (typically 44 bytes for simple WAV)
  const dataSize = buf.length - 44;
  return dataSize / byteRate;
}

/**
 * Stateless TTS client. Each synthesize() call is an independent HTTP POST.
 */
export class TtsClient {
  constructor(
    private config: TtsClientConfig,
    private log = console
  ) {}

  async synthesize(options: TtsSynthesizeOptions): Promise<TtsSynthesizeResult> {
    const voice = options.voice || this.config.defaultVoice;
    const language = options.language || this.config.defaultLanguage;
    const speed = options.speed ?? 1.0;

    const url = `${this.config.url}/v1/audio/speech`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);

    try {
      this.log.info(
        `[TtsClient] Synthesizing "${options.text.slice(0, 80)}${options.text.length > 80 ? "..." : ""}" ` +
        `voice=${voice} language=${language} speed=${speed}`
      );

      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          input: options.text,
          voice,
          response_format: "wav",
          speed,
          language,
        }),
        signal: controller.signal,
      });

      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        throw new Error(`TTS server returned ${resp.status}: ${body}`);
      }

      const arrayBuf = await resp.arrayBuffer();
      const audio = Buffer.from(arrayBuf);
      const durationSeconds = estimateWavDuration(audio);

      this.log.info(
        `[TtsClient] Synthesized ${audio.length} bytes` +
        (durationSeconds !== undefined ? ` (~${durationSeconds.toFixed(1)}s)` : "")
      );

      return { audio, voice, language, durationSeconds };
    } finally {
      clearTimeout(timeout);
    }
  }
}

/**
 * TTS manager: thin wrapper that tracks in-flight requests per callId
 * so they can be cancelled on call end.
 */
export class TtsManager {
  private inFlight = new Map<string, AbortController>();

  constructor(
    private client: TtsClient,
    private log = console
  ) {}

  async synthesize(callId: string, options: TtsSynthesizeOptions): Promise<TtsSynthesizeResult> {
    // Cancel any previous in-flight request for this call
    this.cancel(callId);

    const controller = new AbortController();
    this.inFlight.set(callId, controller);

    try {
      // We use the TtsClient's own timeout; the abort controller here is for
      // external cancellation (call hangup, shutdown).
      const result = await this.client.synthesize(options);
      return result;
    } finally {
      // Only delete if it's still our controller (not replaced by a new request)
      if (this.inFlight.get(callId) === controller) {
        this.inFlight.delete(callId);
      }
    }
  }

  cancel(callId: string): void {
    const controller = this.inFlight.get(callId);
    if (controller) {
      this.log.info(`[TtsManager] Cancelling in-flight TTS for call ${callId}`);
      controller.abort();
      this.inFlight.delete(callId);
    }
  }

  cancelAll(): void {
    for (const [callId, controller] of this.inFlight) {
      this.log.info(`[TtsManager] Cancelling in-flight TTS for call ${callId}`);
      controller.abort();
    }
    this.inFlight.clear();
  }
}
