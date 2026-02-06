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
  audio: z.object({
    /** Base URL for uploading/managing sounds on Asterisk via ARI HTTP */
    asteriskSoundsDir: z.string().default("/var/lib/asterisk/sounds/custom"),
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
    audio: {
      asteriskSoundsDir: process.env.ASTERISK_SOUNDS_DIR,
    },
    openclaw: {
      webhookUrl: process.env.OPENCLAW_WEBHOOK_URL || undefined,
    },
  });
}
