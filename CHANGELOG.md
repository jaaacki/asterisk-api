# Changelog

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
