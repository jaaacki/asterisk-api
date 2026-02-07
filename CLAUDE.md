# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install          # Install dependencies
npm run dev          # Start dev server with hot-reload (tsx watch)
npm run build        # Compile TypeScript → dist/
npm start            # Run compiled JS from dist/
npm run lint         # Type-check only (tsc --noEmit)
```

No test framework is configured. Testing is manual via curl (see TESTS.md, ASR-TESTING.md).

## Architecture

Node.js REST API bridge connecting to Asterisk via ARI (Asterisk REST Interface). Exposes HTTP endpoints and WebSocket event stream for call control, audio streaming, and speech recognition.

### Core Data Flow

```
HTTP Client → api.ts (Express + Zod validation + API key auth)
                ↓
           AriConnection (ari-client wrapper, all Asterisk operations)
                ↓                          ↓
           CallManager              AudioCaptureManager
           (state store,            (snoop + ExternalMedia
            EventEmitter)            audio pipeline)
                ↓                          ↓
           ws-server.ts              AsrManager
           (broadcasts events        (WebSocket client to
            to WS clients)            ASR service)
```

### Key Module Responsibilities

- **`index.ts`** — Bootstrap: loads config, wires dependencies, starts HTTP+WS servers, handles shutdown
- **`config.ts`** — Zod schema validates env vars, exports typed config
- **`api.ts`** — Express routes, Zod request validation, API key middleware, error mapping
- **`call-manager.ts`** — In-memory `Map<string, CallRecord>` state store, EventEmitter for `call:created` and `event` emissions, 5-min auto-cleanup of ended calls
- **`ari-connection.ts`** — Central ARI wrapper (~1000 lines). Handles: connection/reconnect, event handlers (StasisStart/End, DTMF, playback), call control, bridges, recordings, audio capture integration, ASR integration, webhook notifications
- **`ws-server.ts`** — WebSocket at `/events`, sends active call snapshot on connect, broadcasts CallManager events
- **`allowlist.ts`** — Phone number filtering with hot-reload from `allowlist.json`, empty = allow all
- **`audio-capture.ts`** — Per-call audio pipeline: Snoop channel → ExternalMedia → Bridge → WebSocket (PCM 16-bit 16kHz mono)
- **`asr-client.ts`** — WebSocket client to ASR service, sends PCM audio, receives JSON transcriptions, auto-reconnect

### State Management Pattern

CallManager is an EventEmitter that owns all call/bridge state. AriConnection mutates state through CallManager methods and the CallManager broadcasts events. ws-server listens to CallManager events and forwards them to all WebSocket clients. This ensures a single source of truth.

### Audio Pipeline

Audio capture uses three Asterisk channels per capture session:
1. **Snoop channel** — mirrors audio from the active call (direction: `in`)
2. **ExternalMedia channel** — streams audio out via WebSocket
3. **Bridge** — connects Snoop to ExternalMedia

AudioCapture (per-call) → AudioCaptureManager (multi-call) → AriConnection (integration) → AsrManager (speech recognition)

## TypeScript Conventions

- **ESM modules** with `.js` extensions in all imports (not `.ts`)
- **`"type": "module"`** in package.json
- **Zod schemas** for both config validation and HTTP request validation, with `z.infer<>` for type derivation
- **Custom `AriError` class** with HTTP status codes; `parseAriError()` extracts messages from ari-client JSON errors
- Custom type declarations for `ari-client` in `src/types/ari-client.d.ts`

## Environment

Copy `.env.example` to `.env`. Key variables: `ARI_URL`, `ARI_USERNAME`, `ARI_PASSWORD`, `ARI_APP`, `API_PORT`, `API_KEY`, `OPENCLAW_WEBHOOK_URL`.

The ASR service URL is configured via `ASR_URL` env var (e.g., `ws://192.168.2.198:8100/ws/transcribe`).

## Asterisk/FreePBX Context

- Asterisk 21 in Docker on Synology NAS at 192.168.2.198
- ARI on port 8088, Stasis app name must match `ARI_APP` env var
- Inbound calls enter via dialplan context `[openclaw-voice]` in `extensions_custom.conf`
- Never edit `*_additional.conf` files (FreePBX-managed); use `*_custom.conf`
- Docker commands on NAS: `/usr/local/bin/docker exec freepbx asterisk -rx "command"`
