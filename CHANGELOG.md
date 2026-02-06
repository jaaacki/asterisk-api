# Changelog

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
