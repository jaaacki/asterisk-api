import { z } from "zod";
import "dotenv/config";

const ConfigSchema = z.object({
  ari: z.object({
    url: z.string().url(),
    username: z.string().min(1),
    password: z.string().min(1),
    app: z.string().default("openclaw-voice"),
  }),
  api: z.object({
    port: z.coerce.number().int().min(1).max(65535).default(3456),
    host: z.string().default("0.0.0.0"),
    apiKey: z.string().optional(),
  }),
  audio: z.object({}),
  inbound: z.object({
    /** Delay in ms before answering inbound calls (simulates ringing) */
    ringDelayMs: z.coerce.number().int().min(0).default(3000),
  }),
  asr: z.object({
    url: z.string().url().optional(),
    language: z.string().default("English"),
  }),
  tts: z.object({
    url: z.string().url().optional(),
    defaultVoice: z.string().default("vivian"),
    defaultLanguage: z.string().default("English"),
    timeoutMs: z.coerce.number().int().min(1000).default(30000),
  }),
  openclaw: z.object({
    webhookUrl: z.string().url().optional(),
  }),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(): Config {
  return ConfigSchema.parse({
    ari: {
      url: process.env.ARI_URL,
      username: process.env.ARI_USERNAME,
      password: process.env.ARI_PASSWORD,
      app: process.env.ARI_APP,
    },
    api: {
      port: process.env.API_PORT,
      host: process.env.API_HOST,
      apiKey: process.env.API_KEY || undefined,
    },
    audio: {},
    inbound: {
      ringDelayMs: process.env.INBOUND_RING_DELAY_MS,
    },
    asr: {
      url: process.env.ASR_URL,
      language: process.env.ASR_LANGUAGE,
    },
    tts: {
      url: process.env.TTS_URL,
      defaultVoice: process.env.TTS_DEFAULT_VOICE,
      defaultLanguage: process.env.TTS_DEFAULT_LANGUAGE,
      timeoutMs: process.env.TTS_TIMEOUT_MS,
    },
    openclaw: {
      webhookUrl: process.env.OPENCLAW_WEBHOOK_URL || undefined,
    },
  });
}
