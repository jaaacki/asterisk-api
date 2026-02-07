/**
 * WAV header parser and PCM extraction utilities.
 *
 * Parses RIFF/WAVE buffers from TTS into raw PCM data,
 * converts formats to mono 16-bit, and maps sample rates
 * to Asterisk slin codec names.
 */

export interface WavInfo {
  sampleRate: number;
  bitDepth: number;
  channels: number;
  /** Raw PCM bytes (WAV header stripped) */
  data: Buffer;
  durationSeconds: number;
}

/**
 * Parse a WAV buffer, extracting format info and raw PCM data.
 * Supports PCM (format tag 1) only.
 */
export function parseWav(buf: Buffer): WavInfo {
  if (buf.length < 44) {
    throw new Error("Buffer too small to be a valid WAV file");
  }

  const riff = buf.toString("ascii", 0, 4);
  if (riff !== "RIFF") {
    throw new Error(`Not a RIFF file (got "${riff}")`);
  }

  const wave = buf.toString("ascii", 8, 12);
  if (wave !== "WAVE") {
    throw new Error(`Not a WAVE file (got "${wave}")`);
  }

  // Walk chunks to find "fmt " and "data"
  let offset = 12;
  let sampleRate = 0;
  let bitDepth = 0;
  let channels = 0;
  let dataStart = 0;
  let dataSize = 0;

  while (offset + 8 <= buf.length) {
    const chunkId = buf.toString("ascii", offset, offset + 4);
    const chunkSize = buf.readUInt32LE(offset + 4);

    if (chunkId === "fmt ") {
      if (chunkSize < 16) {
        throw new Error("fmt chunk too small");
      }
      const audioFormat = buf.readUInt16LE(offset + 8);
      if (audioFormat !== 1) {
        throw new Error(`Unsupported audio format: ${audioFormat} (only PCM/1 supported)`);
      }
      channels = buf.readUInt16LE(offset + 10);
      sampleRate = buf.readUInt32LE(offset + 12);
      // skip byteRate (4 bytes) and blockAlign (2 bytes)
      bitDepth = buf.readUInt16LE(offset + 22);
    } else if (chunkId === "data") {
      dataStart = offset + 8;
      dataSize = chunkSize;
      break; // data chunk found — stop
    }

    // Advance to next chunk (chunkSize may be odd-padded)
    offset += 8 + chunkSize;
    if (chunkSize % 2 !== 0) offset += 1;
  }

  if (!sampleRate || !channels || !bitDepth) {
    throw new Error("WAV file missing fmt chunk or invalid format fields");
  }
  if (!dataStart || !dataSize) {
    throw new Error("WAV file missing data chunk");
  }

  // Clamp dataSize to actual buffer bounds
  const available = buf.length - dataStart;
  if (dataSize > available) {
    dataSize = available;
  }

  const data = buf.subarray(dataStart, dataStart + dataSize);
  const bytesPerSample = bitDepth / 8;
  const totalSamples = dataSize / (bytesPerSample * channels);
  const durationSeconds = totalSamples / sampleRate;

  return { sampleRate, bitDepth, channels, data, durationSeconds };
}

/**
 * Convert WAV PCM data to mono 16-bit if needed.
 * - Stereo → mono (average L+R)
 * - 8-bit → 16-bit
 * Uses Int16Array typed arrays for fast indexed access (2-3x faster than readInt16LE per sample).
 * Returns a new WavInfo with converted data, or the same if already mono 16-bit.
 */
export function toMono16bit(info: WavInfo): WavInfo {
  let { data, sampleRate, bitDepth, channels, durationSeconds } = info;

  // Convert 8-bit unsigned to 16-bit signed
  if (bitDepth === 8) {
    const outBuf = Buffer.alloc(data.length * 2);
    const dst = new Int16Array(outBuf.buffer, outBuf.byteOffset, data.length);
    for (let i = 0; i < data.length; i++) {
      // 8-bit WAV is unsigned 0–255, center at 128 → signed 16-bit
      dst[i] = (data[i] - 128) << 8;
    }
    data = outBuf;
    bitDepth = 16;
  }

  // Convert stereo to mono (average L+R) using Int16Array views
  if (channels === 2 && bitDepth === 16) {
    const sampleCount = data.length / 4; // 2 channels × 2 bytes
    const src = new Int16Array(data.buffer, data.byteOffset, data.length / 2);
    const outBuf = Buffer.alloc(sampleCount * 2);
    const dst = new Int16Array(outBuf.buffer, outBuf.byteOffset, sampleCount);
    for (let i = 0; i < sampleCount; i++) {
      dst[i] = Math.round((src[i * 2] + src[i * 2 + 1]) / 2);
    }
    data = outBuf;
    channels = 1;
  }

  return { sampleRate, bitDepth, channels, data, durationSeconds };
}

/** Standard Asterisk slin sample rates */
const SLIN_RATES = [8000, 12000, 16000, 24000, 32000, 44100, 48000, 96000, 192000];

/**
 * Map a sample rate to the corresponding Asterisk slin codec name.
 * 8000 → "slin", 16000 → "slin16", 24000 → "slin24", etc.
 *
 * If the rate has no exact slin match, returns the nearest lower standard rate
 * and the caller should resample.
 */
export function slinFormatName(sampleRate: number): string {
  // Find exact or nearest lower standard rate
  let best = 8000;
  for (const rate of SLIN_RATES) {
    if (rate <= sampleRate) best = rate;
  }

  if (best === 8000) return "slin";
  return `slin${best / 1000}`;
}

/**
 * Check if a sample rate has a direct slin mapping in Asterisk.
 */
export function hasExactSlinRate(sampleRate: number): boolean {
  return SLIN_RATES.includes(sampleRate);
}

/**
 * Resample PCM 16-bit mono data via linear interpolation.
 * Uses Int16Array typed arrays for fast indexed access.
 * Only use when the source rate has no exact slin match.
 */
export function resample(data: Buffer, fromRate: number, toRate: number): Buffer {
  if (fromRate === toRate) return data;

  const srcSamples = data.length / 2;
  const dstSamples = Math.round(srcSamples * (toRate / fromRate));
  const outBuf = Buffer.alloc(dstSamples * 2);
  const ratio = fromRate / toRate;

  const src = new Int16Array(data.buffer, data.byteOffset, srcSamples);
  const dst = new Int16Array(outBuf.buffer, outBuf.byteOffset, dstSamples);

  for (let i = 0; i < dstSamples; i++) {
    const srcPos = i * ratio;
    const srcIdx = Math.floor(srcPos);
    const frac = srcPos - srcIdx;

    const s0 = srcIdx < srcSamples ? src[srcIdx] : 0;
    const s1 = srcIdx + 1 < srcSamples ? src[srcIdx + 1] : s0;
    const sample = Math.round(s0 + (s1 - s0) * frac);

    dst[i] = Math.max(-32768, Math.min(32767, sample));
  }

  return outBuf;
}
