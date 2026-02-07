# Voice Call Streaming Implementation Plan

## Goal
Enable real-time voice conversations: Phone → ASR (streaming) → Agent → TTS → Phone

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                          Phone Call                                  │
└─────────────────────────────────────────────────────────────────────┘
                                ↕ RTP
┌─────────────────────────────────────────────────────────────────────┐
│                      Asterisk (ARI)                                  │
│                   ExternalMedia / Snoop                              │
└─────────────────────────────────────────────────────────────────────┘
                                ↕ audio frames
┌─────────────────────────────────────────────────────────────────────┐
│                      asterisk-api                                    │
│  v0.2.x: Audio capture from ARI                                      │
│  v0.3.x: WebSocket client to ASR                                     │
│  v0.4.x: Receive TTS audio, play to call                             │
└─────────────────────────────────────────────────────────────────────┘
           ↕ WS: audio chunks              ↕ WS: transcription
┌─────────────────────────────┐    ┌──────────────────────────────────┐
│      qwen3-asr-server       │    │    openclaw-voice-call plugin     │
│  v0.2.x: WebSocket endpoint │    │  v0.3.x: Conversation orchestrator│
│  - Accept audio chunks      │    │  - Receive transcriptions         │
│  - Stream transcriptions    │    │  - Agent response                 │
│  - VAD (voice activity)     │    │  - TTS generation                 │
└─────────────────────────────┘    │  - Send audio to play             │
                                   └──────────────────────────────────┘
```

## Components & Tasks

### Component 1: qwen3-asr-server (WebSocket)
Location: `~/Dev/qwen3-asr-server/` (or wherever the ASR server lives)

| Version | Task | Description |
|---------|------|-------------|
| 0.2.0 | WebSocket endpoint | `/ws/transcribe` - accept audio chunks, return text |
| 0.2.1 | VAD integration | Voice Activity Detection for utterance boundaries |
| 0.2.2 | Partial results | Stream partial transcriptions as audio comes in |

### Component 2: asterisk-api (Audio Streaming)
Location: `~/Dev/openclaw-freepbx/asterisk-api/`

| Version | Task | Description |
|---------|------|-------------|
| 0.2.0 | Audio capture | Use ARI ExternalMedia to capture call audio |
| 0.2.1 | WebSocket to ASR | Stream audio chunks to ASR WebSocket |
| 0.2.2 | Transcription events | Forward transcriptions to OpenClaw via WS |
| 0.3.0 | TTS playback | Accept audio URLs/data, play to active call |

### Component 3: openclaw-voice-call (Orchestration)
Location: `~/Dev/openclaw-freepbx/openclaw-voice-call/`

| Version | Task | Description |
|---------|------|-------------|
| 0.3.0 | Transcription handler | Receive and process transcription events |
| 0.3.1 | Agent integration | Feed transcriptions to agent, get responses |
| 0.3.2 | TTS generation | Use qwen3-tts to generate response audio |
| 0.3.3 | Playback trigger | Send audio to asterisk-api for playback |

## Task Breakdown (for agents)

### Task 1: ASR WebSocket Endpoint (qwen3-asr-server v0.2.0)
**Priority:** HIGH - Foundation for everything else
**Agent:** Background agent 1

Requirements:
- Add WebSocket endpoint `/ws/transcribe`
- Accept binary audio frames (PCM 16-bit, 16kHz)
- Buffer audio, run through model
- Return JSON: `{"text": "...", "is_partial": bool, "is_final": bool}`
- Handle connection lifecycle

Files to create/modify:
- `server.py` - add WebSocket route
- `websocket_handler.py` - new file for WS logic

### Task 2: ARI Audio Capture (asterisk-api v0.2.0)
**Priority:** HIGH - Needed to get audio from calls
**Agent:** Background agent 2

Requirements:
- Use ARI ExternalMedia or Snoop channel
- Capture audio frames from active call
- Convert to PCM 16-bit 16kHz if needed
- Emit audio frames via internal event

Files to modify:
- `src/ari-connection.ts` - add audio capture
- `src/audio-capture.ts` - new file

### Task 3: ASR Client in asterisk-api (asterisk-api v0.2.1)
**Priority:** MEDIUM - Connects audio to ASR
**Agent:** Background agent 2 (after Task 2)

Requirements:
- WebSocket client to ASR service
- Stream captured audio frames
- Receive transcription events
- Forward to OpenClaw plugin via existing WS

### Task 4: Transcription Handler (openclaw-voice-call v0.3.0)
**Priority:** MEDIUM - Process transcriptions
**Agent:** Background agent 3

Requirements:
- Handle `call.transcription` events
- Buffer partial transcriptions
- Detect utterance completion
- Trigger agent processing

### Task 5: Agent + TTS Response (openclaw-voice-call v0.3.1-0.3.2)
**Priority:** MEDIUM - Complete the loop
**Agent:** Background agent 3 (after Task 4)

Requirements:
- Pass transcription to OpenClaw agent
- Get text response
- Call qwen3-tts to generate audio
- Send audio URL to asterisk-api

## Execution Order

```
Phase 1 (Parallel):
  ├── Agent 1: Task 1 (ASR WebSocket)
  └── Agent 2: Task 2 (ARI Audio Capture)

Phase 2 (After Phase 1):
  └── Agent 2: Task 3 (ASR Client)

Phase 3 (After Phase 2):
  └── Agent 3: Task 4 (Transcription Handler)

Phase 4 (After Phase 3):
  └── Agent 3: Task 5 (Agent + TTS)
```

## Notes

- ASR service code needs to be located first
- May need to create new repo for ASR server if modifying existing
- TTS already works via HTTP, no changes needed there
- Each task = version increment with changelog entry
