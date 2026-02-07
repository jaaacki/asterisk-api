# Streaming Implementation Tasks

## Active Agents

| Agent Label | Session Key | Task | Status |
|-------------|-------------|------|--------|
| asr-websocket | agent:main:subagent:146a790d-e001-4f73-a48d-4ed338e7bd25 | ASR WebSocket (v0.2.0) | 🔄 In Progress |
| ari-audio-capture | agent:main:subagent:e82f89c8-2efb-47b0-8619-730ba2fe1c9d | ARI Audio Capture (v0.2.0) | 🔄 In Progress |

## Task Queue (Pending)

| Task | Component | Version | Dependencies | Assigned |
|------|-----------|---------|--------------|----------|
| ASR Client | asterisk-api | v0.2.1 | ari-audio-capture, asr-websocket | - |
| Transcription Handler | openclaw-voice-call | v0.3.0 | ASR Client | - |
| Agent + TTS Response | openclaw-voice-call | v0.3.1-0.3.2 | Transcription Handler | - |

## Completed Tasks

| Task | Component | Version | Completed | Agent |
|------|-----------|---------|-----------|-------|
| - | - | - | - | - |

## Commands

Check agent status:
```bash
# List all sessions
openclaw sessions list

# Check specific agent
openclaw sessions history --session-key <key>
```

## Notes

- Phase 1 (parallel): ASR WebSocket + ARI Audio Capture
- Phase 2: ASR Client (depends on Phase 1)
- Phase 3: Transcription Handler
- Phase 4: Agent + TTS Response
