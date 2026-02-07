# Changelog

## [0.2.2] - 2026-02-07

### Fixed
- **ASR URL no longer hardcoded** — moved to `ASR_URL` env var via `asr.url` config field
- **ExternalMedia WebSocket URL** — fixed URL from wrong `/ari/externalMedia/<id>` to correct `/media/<connectionId>` using `MEDIA_WEBSOCKET_CONNECTION_ID` from channel vars
- **ExternalMedia Stasis race condition** — WebSocket client now connects BEFORE bridging (server-mode channels only enter Stasis after client connects); added `"media"` subprotocol
- **Webhook URL in `.env.example`** — changed `localhost` to `host.docker.internal` so Docker containers can reach the host

### Added
- **Auto-start audio capture on ready** — inbound calls automatically start the full audio pipeline (snoop → ExternalMedia → bridge → ASR) after greeting + beep, no manual API call needed
- `ASR_URL` in `.env.example` template

## [0.2.1] - 2026-02-07

### Added
- **ASR (Automatic Speech Recognition) integration**
  - `AsrClient` class for managing WebSocket connections to ASR service
  - `AsrManager` class for managing multiple ASR sessions across calls
  - Real-time audio streaming to ASR service at `ws://192.168.2.198:8100/ws/transcribe`
  - Automatic ASR session lifecycle tied to audio capture (start/stop)
  - ASR reconnection logic with configurable retry attempts
- **Complete ExternalMedia WebSocket audio streaming**
  - Full implementation of ExternalMedia WebSocket connection to Asterisk
  - Binary audio frame reception from Asterisk ARI WebSocket
  - Audio frame emission to both WebSocket clients and ASR service
- **New WebSocket event: `call.transcription`**
  - Emitted for each transcription result (partial and final)
  - Payload: `{ text, is_partial, is_final }`
  - Final transcriptions also sent to OpenClaw webhook
- **ASR control commands**
  - `flush` - flush buffered audio and get final transcription
  - `reset` - reset ASR session state

### Changed
- `AudioCaptureManager` now accepts ARI WebSocket URL and credentials for ExternalMedia connection
- `AudioCapture` now connects to Asterisk's ExternalMedia WebSocket endpoint
- Audio frames are sent to both WebSocket clients (base64) and ASR service (binary PCM)
- Audio capture cleanup now includes WebSocket closure and bridge destruction

### Technical Details
- ASR protocol: send binary PCM 16-bit 16kHz mono, receive JSON `{text, is_partial, is_final}`
- ExternalMedia WebSocket URL format: `ws://<host>:<port>/ari/externalMedia/<channelId>?api_key=<user>:<pass>`
- ASR sessions automatically start when audio capture begins
- ASR sessions automatically end when audio capture stops or call ends
- Automatic ASR reconnection on WebSocket failures (max 10 attempts by default)

### Notes
- This completes the audio → ASR → transcription pipeline started in v0.2.0
- ASR service must be running at `ws://192.168.2.198:8100/ws/transcribe`
- Audio frames flow: Call → Snoop → Bridge → ExternalMedia → WebSocket → Node.js → ASR

## [0.2.0] - 2026-02-07

### Added
- Real-time audio capture from phone calls via ARI
- `AudioCaptureManager` class for managing audio capture sessions
- `AudioCapture` class for per-call audio capture using Snoop + ExternalMedia channels
- Audio capture types: `AudioCaptureInfo`, `AudioFrame`, `AudioCaptureConfig`
- `POST /calls/:id/audio/start` endpoint to start audio capture on a call
- `POST /calls/:id/audio/stop` endpoint to stop audio capture
- WebSocket events for audio capture:
  - `call.audio_capture_started` - fired when audio capture starts
  - `call.audio_capture_stopped` - fired when audio capture stops
  - `call.audio_frame` - emits audio frames (base64-encoded PCM data)
  - `call.audio_capture_error` - fired on audio capture errors
- `audioCapture` field in `CallRecord` to track audio capture status
- Automatic audio capture cleanup on call end (`StasisEnd`)
- Automatic audio capture cleanup on ARI disconnect

### Technical Details
- Audio capture uses ARI Snoop to create monitoring channel
- ExternalMedia channel streams audio via WebSocket (server mode)
- Default format: PCM 16-bit, 16kHz mono (`slin16`)
- Spy direction: `in` (captures incoming audio from caller)
- Audio frames chunked at ~100ms intervals (1600 samples @ 16kHz)

### Notes
- This is an experimental feature for real-time audio processing
- Full WebSocket audio streaming implementation requires additional work
- Currently sets up the ARI infrastructure; audio frame emission is a placeholder

## [0.1.7] - 2026-02-07

### Added
- `INBOUND_RING_DELAY_MS` config — delay before answering inbound calls (default: 3000ms)
- `INBOUND_GREETING_SOUND` config — sound file to play after answering (default: hello-world)
- Proper "ringing" state for inbound calls before answer

### Changed
- Inbound calls now ring for configurable delay before auto-answer (more natural UX)
- State flow: `ringing` → (delay) → `answered` → play greeting
- `call.inbound` webhook fires immediately, `call.answered` fires after delay

## [0.1.6] - 2026-02-07

### Added
- `GET /allowlist` endpoint to view current inbound/outbound allowlist
- `POST /allowlist/reload` endpoint to reload allowlist from file
- Outbound allowlist enforcement on `POST /calls` — returns 403 if destination not in allowlist
- Inbound allowlist enforcement on `StasisStart` — hangs up calls from non-allowed callers

### Changed
- `POST /calls` now returns detailed 403 error when blocked by allowlist, including extracted number and hint

### Security
- Shared trunk now protected by allowlist at API level
- Both inbound and outbound calls filtered before processing

## [0.1.5] - 2026-02-07

### Added
- `allowlist.json` configuration file for inbound/outbound phone number filtering
- `allowlist.schema.json` JSON Schema for allowlist validation
- `src/allowlist.ts` module with:
  - `loadAllowlist()` — load allowlist from JSON file
  - `watchAllowlist()` — auto-reload on file changes
  - `isOutboundAllowed(endpoint)` — check if outbound call is permitted
  - `isInboundAllowed(callerId)` — check if inbound caller is permitted
  - `normalizeNumber()` — strip non-digit characters
  - `extractNumberFromEndpoint()` — extract phone number from SIP endpoint string
- Allowlist loaded on server startup with hot-reload support

### Notes
- Empty allowlist arrays = allow all (open mode)
- Numbers stored without '+' prefix (e.g., "659654255" not "+659654255")

## [0.1.4] - 2026-02-07

### Added
- `GET /recordings` to list all stored recordings from Asterisk
- `GET /recordings/:name` to get recording metadata
- `POST /recordings/:name/copy` to copy a stored recording `{ destinationName }`
- `DELETE /recordings/:name?stored=true` to delete stored recordings (vs. stopping live ones)
- Recording management methods in AriConnection: `listStoredRecordings()`, `getStoredRecording()`, `deleteStoredRecording()`, `copyStoredRecording()`
- `copyStored()` method added to ari-client type declarations

### Changed
- Renamed `getRecording()` to `getRecordingFile()` for clarity (file download vs. metadata)
- `DELETE /recordings/:name` now supports `?stored=true` query param to distinguish between stopping a live recording and deleting a stored one

## [0.1.3] - 2026-02-07

### Added
- Bridge CRUD routes: `POST /bridges`, `GET /bridges`, `GET /bridges/:id`, `DELETE /bridges/:id`
- Bridge channel management: `POST /bridges/:id/addChannel`, `POST /bridges/:id/removeChannel`
- `POST /calls/:id/transfer` endpoint — creates a bridge, dials a new endpoint, and connects both channels
- `BridgeRecord` type and `TransferRequest` type in types.ts
- Bridge tracking in CallManager: `createBridge()`, `getBridge()`, `listBridges()`, `deleteBridge()`, `addChannelToBridge()`, `removeChannelFromBridge()`
- `clearBridge()` method on CallManager to disassociate a call from a bridge
- Bridge events emitted on the WebSocket stream (`bridge.created`, `bridge.destroyed`)

### Changed
- CallManager `setBridge()` now also sets call state to "bridged"

## [0.1.2] - 2026-02-07

### Added
- `POST /calls/:id/play/file` endpoint for uploading raw WAV/PCM audio and playing it on a channel
- Sequential media playback: `POST /calls/:id/play` now accepts an array of media URIs
- `playMediaSequence()` method in AriConnection for playing multiple media items in order
- `uploadAndPlayFile()` method that uploads audio via ARI HTTP and plays it
- `audio.asteriskSoundsDir` config option for configurable Asterisk sounds path
- `ASTERISK_SOUNDS_DIR` environment variable

### Changed
- `PlayRequestSchema` now accepts both a single string and an array of strings for the `media` field

## [0.1.1] - 2026-02-07

### Added
- Zod request body schemas for all mutating endpoints (OriginateRequestSchema, PlayRequestSchema, RecordRequestSchema, DtmfRequestSchema)
- Proper HTTP status codes: 400 for validation errors, 404 for not found, 503 for ARI disconnected
- `GET /endpoints` route to list available SIP/PJSIP endpoints from Asterisk
- `GET /` route with API overview showing all available endpoints and their payloads
- Custom `AriError` class with HTTP status code hints
- ARI error response parser to extract meaningful messages from raw JSON errors
- Endpoint availability check before originate — returns 404 if endpoint does not exist

### Changed
- All ARI methods now throw `AriError` with appropriate status codes instead of generic Error
- Error responses unified through `errorResponse()` helper for consistent JSON output

## [0.1.0] - 2026-02-07

### Added
- Project scaffold: TypeScript + ESM, Express, ari-client, ws, zod
- ARI connection manager with auto-reconnect
- Call state manager with event emitter
- REST API: /health, /calls CRUD, /calls/:id/play, /calls/:id/record, /calls/:id/dtmf
- WebSocket event stream at /events
- Webhook callback to OpenClaw plugin
- Custom TypeScript declarations for ari-client
- Stasis dialplan context `[openclaw-voice]` on FreePBX server
