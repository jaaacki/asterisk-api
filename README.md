# asterisk-api

A Node.js REST API bridge that connects to Asterisk via ARI (Asterisk REST Interface), exposing HTTP endpoints and a WebSocket event stream for programmatic call control.

Built as the telephony backend for [OpenClaw](https://github.com/jaaacki/openclaw) voice-call integration with FreePBX/Asterisk.

## Features

- **Call control** — originate, answer, hang up, transfer calls
- **Media playback** — play built-in sounds, sequential playlists, or upload raw WAV files
- **Recording** — start/stop call recording, list, download, copy, and delete stored recordings
- **DTMF** — send DTMF tones on active calls
- **Bridges** — create mixing bridges to connect multiple call legs (conferencing, transfers)
- **Real-time events** — WebSocket stream pushes call state changes, DTMF, and bridge events to connected clients
- **Webhook callbacks** — forward call events to an external service (e.g. OpenClaw gateway)
- **Endpoint discovery** — list available SIP/PJSIP endpoints from Asterisk

## Tech Stack

| Component | Library |
|---|---|
| Runtime | Node.js >= 18, TypeScript (ESM) |
| Asterisk ARI | [ari-client](https://www.npmjs.com/package/ari-client) v2.2 |
| HTTP server | [Express](https://expressjs.com/) v4 |
| WebSocket | [ws](https://www.npmjs.com/package/ws) v8 |
| Validation | [zod](https://zod.dev/) v3 |
| Dev tooling | [tsx](https://www.npmjs.com/package/tsx) (hot-reload), TypeScript 5 |

## Prerequisites

- **Node.js** >= 18
- **Asterisk** with ARI enabled (tested with Asterisk 21 / FreePBX 17)
- An ARI user configured in Asterisk (`ari.conf`)
- A Stasis dialplan context that routes calls into your ARI application

## Setup

### 1. Clone and configure

```bash
git clone <repo-url>
cd asterisk-api
cp .env.example .env
```

Edit `.env` with your Asterisk connection details:

```env
# Asterisk ARI connection
ARI_URL=http://192.168.2.198:8088
ARI_USERNAME=asterisk_ari
ARI_PASSWORD=asterisk_ari_pass
ARI_APP=openclaw-voice

# API server
API_PORT=3456
API_HOST=0.0.0.0

# Webhook callback URL (optional, where to forward call events)
OPENCLAW_WEBHOOK_URL=http://localhost:18789/voice/webhook

# API key for securing this API (optional, leave empty to disable)
API_KEY=
```

### 2. Asterisk configuration

Ensure ARI is enabled in your Asterisk instance:

**ari.conf**
```ini
[general]
enabled = yes

[asterisk_ari]
type = user
password = asterisk_ari_pass
read_only = no
```

**extensions_custom.conf** — route inbound calls to the Stasis application:
```ini
[openclaw-voice]
exten => _X.,1,NoOp(Incoming call to OpenClaw Voice)
 same => n,Stasis(openclaw-voice)
 same => n,Hangup()
```

### 3. Run — Local

```bash
npm install

# Development (hot-reload)
npm run dev

# Production
npm run build
npm start
```

### 4. Run — Docker

Docker Compose uses profiles to separate dev and prod workflows.

**Production** — builds a minimal image and runs compiled JS:

```bash
docker compose --profile prod up -d
```

**Development** — mounts `src/` into the container with hot-reload via tsx:

```bash
docker compose --profile dev up
```

Edit files under `src/` on your host and the container picks up changes automatically.

**Useful Docker commands:**

```bash
# View logs
docker compose --profile prod logs -f

# Stop
docker compose --profile prod down

# Rebuild after dependency changes
docker compose --profile prod up -d --build

# Health check
docker inspect --format='{{.State.Health.Status}}' asterisk-api-asterisk-api-1

# Shell into running container
docker compose --profile prod exec asterisk-api sh
```

**Network considerations:** The container must be able to reach your Asterisk server. If Asterisk runs on the Docker host, `ARI_URL` in `.env` should use the host's LAN IP (e.g. `http://192.168.2.198:8088`), not `localhost`. On Linux you can also use `host.docker.internal` with `--add-host` or `extra_hosts` in compose.

The server starts on `http://0.0.0.0:3456` by default.

## API Reference

Visit `GET /` on a running instance for a live endpoint listing.

### Health

| Method | Path | Description |
|---|---|---|
| `GET` | `/` | API overview with all available endpoints |
| `GET` | `/health` | Health check — ARI connection status, active call count |

### Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/endpoints` | List available SIP/PJSIP endpoints from Asterisk |

### Calls

| Method | Path | Description |
|---|---|---|
| `GET` | `/calls` | List active calls |
| `GET` | `/calls/:id` | Get call details |
| `POST` | `/calls` | Originate an outbound call |
| `DELETE` | `/calls/:id` | Hang up a call |
| `POST` | `/calls/:id/play` | Play audio (single sound or sequential playlist) |
| `POST` | `/calls/:id/play/file` | Upload and play a raw WAV file |
| `POST` | `/calls/:id/record` | Start recording |
| `POST` | `/calls/:id/dtmf` | Send DTMF tones |
| `POST` | `/calls/:id/transfer` | Transfer call to another endpoint |

### Bridges

| Method | Path | Description |
|---|---|---|
| `POST` | `/bridges` | Create a mixing bridge |
| `GET` | `/bridges` | List all bridges |
| `GET` | `/bridges/:id` | Get bridge details |
| `DELETE` | `/bridges/:id` | Destroy a bridge |
| `POST` | `/bridges/:id/addChannel` | Add a call to a bridge |
| `POST` | `/bridges/:id/removeChannel` | Remove a call from a bridge |

### Recordings

| Method | Path | Description |
|---|---|---|
| `GET` | `/recordings` | List all stored recordings |
| `GET` | `/recordings/:name` | Get recording metadata |
| `GET` | `/recordings/:name/file` | Download recording (audio/wav) |
| `POST` | `/recordings/:name/copy` | Copy a stored recording |
| `DELETE` | `/recordings/:name` | Stop live recording, or delete stored (`?stored=true`) |

### WebSocket

| Protocol | Path | Description |
|---|---|---|
| `WS` | `/events` | Real-time call event stream |

On connect, the WebSocket sends a `snapshot` message with all active calls. Subsequent messages are individual call events:

```json
{
  "type": "call.state_changed",
  "callId": "uuid",
  "timestamp": "2025-01-01T00:00:00.000Z",
  "data": { "previousState": "ringing", "state": "answered" }
}
```

Event types: `call.created`, `call.state_changed`, `call.ended`, `bridge.created`, `bridge.destroyed`

## Usage Examples

### Originate a call

```bash
curl -X POST http://localhost:3456/calls \
  -H "Content-Type: application/json" \
  -d '{"endpoint": "PJSIP/1001", "callerId": "5551234", "timeout": 30}'
```

### Play audio on a call

```bash
curl -X POST http://localhost:3456/calls/<call-id>/play \
  -H "Content-Type: application/json" \
  -d '{"media": "sound:hello-world"}'
```

Sequential playback:

```bash
curl -X POST http://localhost:3456/calls/<call-id>/play \
  -H "Content-Type: application/json" \
  -d '{"media": ["sound:hello-world", "sound:goodbye"]}'
```

### Start recording

```bash
curl -X POST http://localhost:3456/calls/<call-id>/record \
  -H "Content-Type: application/json" \
  -d '{"format": "wav", "maxDurationSeconds": 300}'
```

### Transfer a call

```bash
curl -X POST http://localhost:3456/calls/<call-id>/transfer \
  -H "Content-Type: application/json" \
  -d '{"endpoint": "PJSIP/1002"}'
```

### Connect to the event stream

```bash
websocat ws://localhost:3456/events
```

### Authentication

If `API_KEY` is set in `.env`, all requests (except `GET /`) require the header:

```
X-API-Key: your-api-key
```

Or as a query parameter: `?api_key=your-api-key`

## Project Structure

```
src/
├── index.ts            # Entry point — boots HTTP server, ARI connection, WebSocket
├── config.ts           # Environment config with zod validation
├── api.ts              # Express routes and request validation
├── ari-connection.ts   # ARI client wrapper — call control, media, bridges, recordings
├── call-manager.ts     # In-memory call/bridge state and event emitter
├── ws-server.ts        # WebSocket server broadcasting call events
├── types.ts            # TypeScript interfaces (CallRecord, BridgeRecord, etc.)
└── types/
    └── ari-client.d.ts # Type declarations for ari-client
```

## Architecture

```
Client / OpenClaw Gateway                  FreePBX / Asterisk Host
┌──────────────────────┐                   ┌──────────────────────────┐
│  HTTP client         │ ── REST ────────> │  asterisk-api (:3456)    │
│  WebSocket client    │ <── WS events ─── │    ├─ Express REST API   │
│  Webhook receiver    │ <── POST ──────── │    ├─ WebSocket /events  │
│                      │                   │    └─ Webhook notifier   │
└──────────────────────┘                   │          │               │
                                           │          │ ARI (HTTP+WS) │
                                           │          ▼               │
                                           │  Asterisk (:8088)        │
                                           │    ├─ PJSIP endpoints    │
                                           │    ├─ SIP trunk          │
                                           │    └─ Stasis app         │
                                           └──────────────────────────┘
```

## License

MIT
