# Audio Capture Implementation Summary (v0.2.0)

## Task Completion Report

**Date:** 2026-02-07  
**Version:** 0.2.0  
**Status:** ✅ Core infrastructure complete, ready for testing

---

## What Was Implemented

### 1. Type Definitions (`src/types.ts`)

Added new types for audio capture:

```typescript
interface AudioCaptureInfo {
  enabled: boolean;
  snoopChannelId?: string;
  externalMediaChannelId?: string;
  format: string;
  sampleRate: number;
  startedAt: Date;
}

interface AudioFrame {
  callId: string;
  timestamp: number;
  data: Buffer;
  format: string;
  sampleRate: number;
  channels: number;
  sampleCount: number;
}

interface AudioCaptureConfig {
  enabled: boolean;
  format?: string;
  sampleRate?: number;
  transport?: "websocket" | "udp" | "tcp";
  encapsulation?: "rtp" | "audiosocket" | "none";
}
```

Extended `CallRecord` to include `audioCapture?: AudioCaptureInfo`

### 2. Audio Capture Module (`src/audio-capture.ts`)

Created two main classes:

#### `AudioCapture`
- Manages audio capture for a single call
- Creates Snoop channel to monitor active call
- Creates ExternalMedia channel to stream audio
- Bridges both channels for audio flow
- Emits events: `started`, `stopped`, `frame`, `error`
- Auto-cleanup on stop

#### `AudioCaptureManager`
- Manages multiple audio capture sessions
- Tracks captures by call ID
- Forwards events to parent (ARI connection)
- Batch cleanup on shutdown

**Key Features:**
- Default format: PCM 16-bit, 16kHz mono (slin16)
- Default spy direction: `in` (captures incoming audio from caller)
- WebSocket transport with server mode (Asterisk waits for connection)
- Automatic cleanup on errors

### 3. ARI Connection Integration (`src/ari-connection.ts`)

**Changes:**
- Imported `AudioCaptureManager` and `AudioCaptureInfo`
- Added `audioCaptureManager` private field
- Initialized manager in `connect()` with default options
- Set up event forwarding:
  - `capture.started` → `call.audio_capture_started`
  - `capture.stopped` → `call.audio_capture_stopped`
  - `capture.frame` → `call.audio_frame` (with base64-encoded audio data)
  - `capture.error` → `call.audio_capture_error`
- Added public methods:
  - `startAudioCapture(callId)` → returns `AudioCaptureInfo`
  - `stopAudioCapture(callId)` → void
- Modified `StasisEnd` handler to auto-stop audio capture on call end
- Modified `disconnect()` to stop all captures on shutdown

### 4. API Endpoints (`src/api.ts`)

Added two new routes:

```
POST /calls/:id/audio/start  → Start audio capture
POST /calls/:id/audio/stop   → Stop audio capture
```

Updated API overview (`GET /`) to include new endpoints.

### 5. Documentation

Created comprehensive documentation:
- **`AUDIO_CAPTURE.md`**: Full feature guide with usage examples
- **`CHANGELOG.md`**: Updated with v0.2.0 release notes
- **`package.json`**: Bumped version to 0.2.0

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     WebSocket Client                        │
│          (receives audio frames via /events WS)            │
└────────────────────────┬────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│                   asterisk-api (Node.js)                    │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐  │
│  │          AudioCaptureManager                         │  │
│  │  - Manages multiple AudioCapture instances          │  │
│  │  - Emits events to CallManager WebSocket            │  │
│  └──────────────────────┬───────────────────────────────┘  │
│                         │                                   │
│  ┌──────────────────────▼───────────────────────────────┐  │
│  │          AudioCapture (per call)                     │  │
│  │  - Creates Snoop channel                            │  │
│  │  - Creates ExternalMedia channel                    │  │
│  │  - Bridges them together                            │  │
│  └──────────────────────┬───────────────────────────────┘  │
│                         │ ARI API                           │
└─────────────────────────┼───────────────────────────────────┘
                          ▼
┌─────────────────────────────────────────────────────────────┐
│                    Asterisk (ARI)                           │
│                                                             │
│  Active Call Channel  ──snoop──>  Snoop Channel            │
│                                        │                    │
│                                        ▼                    │
│                                    Bridge                   │
│                                        │                    │
│                                        ▼                    │
│                              ExternalMedia Channel          │
│                              (WebSocket server)             │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

---

## Audio Flow

1. **Client**: `POST /calls/{callId}/audio/start`
2. **API**: Calls `ariConn.startAudioCapture(callId)`
3. **AriConnection**: Calls `audioCaptureManager.startCapture(callId, channelId)`
4. **AudioCapture**:
   - Creates Snoop channel (`ari.channels.snoopChannelWithId`)
   - Creates ExternalMedia channel (`ari.channels.externalMedia`)
   - Creates bridge (`ari.bridges.create`)
   - Adds both channels to bridge (`ari.bridges.addChannel`)
5. **AudioCaptureManager**: Emits `capture.started` event
6. **AriConnection**: Broadcasts `call.audio_capture_started` to WebSocket clients
7. **Audio frames** (when implemented):
   - Asterisk streams audio to ExternalMedia WebSocket
   - Node.js receives frames, parses them
   - Emits `AudioFrame` events
   - Broadcast to WebSocket clients as `call.audio_frame`

---

## Testing Checklist

### Unit Tests (TODO)
- [ ] AudioCapture.start() creates snoop and ExternalMedia channels
- [ ] AudioCapture.stop() cleans up channels
- [ ] AudioCaptureManager tracks multiple captures
- [ ] AriConnection integrates audio capture correctly

### Integration Tests (TODO)
- [ ] Start audio capture on active call
- [ ] Stop audio capture manually
- [ ] Audio capture stops automatically when call ends
- [ ] Multiple simultaneous captures work correctly
- [ ] WebSocket receives `call.audio_capture_started` event

### Manual Testing
1. Start API server: `npm run dev`
2. Originate a call: `POST /calls`
3. Start audio capture: `POST /calls/{id}/audio/start`
4. Verify response contains `audioCapture` info
5. Connect WebSocket client: `websocat ws://localhost:3456/events`
6. Verify `call.audio_capture_started` event is received
7. Stop audio capture: `POST /calls/{id}/audio/stop`
8. Verify `call.audio_capture_stopped` event is received
9. Hang up call and verify cleanup

---

## Known Limitations

### Audio Frame Emission (TODO)

The current implementation sets up the ARI infrastructure but does **not yet emit real audio frames**. To complete this:

1. **Connect to Asterisk's ExternalMedia WebSocket**:
   ```typescript
   // In AudioCapture.start(), after creating ExternalMedia channel:
   const wsUrl = `ws://${asteriskHost}:8088/ari/events?app=openclaw-voice`;
   const ws = new WebSocket(wsUrl);
   ws.on('message', (data) => {
     // Parse audio frame from binary data
     const audioFrame: AudioFrame = {
       callId: this.callId,
       timestamp: Date.now(),
       data: data, // Raw PCM buffer
       format: 'slin16',
       sampleRate: 16000,
       channels: 1,
       sampleCount: data.length / 2, // 16-bit = 2 bytes per sample
     };
     this.emit('frame', audioFrame);
   });
   ```

2. **Handle WebSocket lifecycle**:
   - Store WebSocket connection in `AudioCapture` instance
   - Close WebSocket in `cleanup()`
   - Handle reconnection on connection loss

3. **Process RTP (if using UDP transport)**:
   - Set up UDP listener
   - Parse RTP packets
   - Extract audio payloads

---

## API Reference

### Start Audio Capture

**Request:**
```http
POST /calls/{callId}/audio/start
```

**Response:**
```json
{
  "audioCapture": {
    "enabled": true,
    "snoopChannelId": "snoop-{uuid}",
    "externalMediaChannelId": "audiocap-{uuid}",
    "format": "slin16",
    "sampleRate": 16000,
    "startedAt": "2026-02-07T05:00:00.000Z"
  }
}
```

### Stop Audio Capture

**Request:**
```http
POST /calls/{callId}/audio/stop
```

**Response:**
```http
204 No Content
```

### WebSocket Events

#### `call.audio_capture_started`
```json
{
  "type": "call.audio_capture_started",
  "callId": "uuid",
  "timestamp": "2026-02-07T05:00:00.000Z",
  "data": { /* AudioCaptureInfo */ }
}
```

#### `call.audio_frame` (placeholder)
```json
{
  "type": "call.audio_frame",
  "callId": "uuid",
  "timestamp": "2026-02-07T05:00:00.100Z",
  "data": {
    "timestamp": 1707280800100,
    "format": "slin16",
    "sampleRate": 16000,
    "channels": 1,
    "sampleCount": 1600,
    "data": "base64-encoded-pcm-data..."
  }
}
```

---

## Files Modified/Created

### New Files
- `src/audio-capture.ts` (8.9 KB) - Core audio capture logic
- `AUDIO_CAPTURE.md` (9.5 KB) - Feature documentation
- `IMPLEMENTATION_SUMMARY.md` (this file)

### Modified Files
- `src/types.ts` - Added audio capture types
- `src/ari-connection.ts` - Integrated AudioCaptureManager
- `src/api.ts` - Added audio capture endpoints
- `CHANGELOG.md` - v0.2.0 release notes
- `package.json` - Version bump to 0.2.0

---

## Next Steps

1. **Implement WebSocket audio streaming** (highest priority)
   - Connect to Asterisk's ExternalMedia WebSocket
   - Parse incoming binary audio frames
   - Emit real `AudioFrame` events

2. **Add tests**
   - Unit tests for AudioCapture and AudioCaptureManager
   - Integration tests with mock ARI client
   - End-to-end test with real Asterisk instance

3. **Performance optimization**
   - Monitor resource usage with multiple captures
   - Implement backpressure handling for audio frames
   - Add configuration for frame buffering

4. **Additional features**
   - Bidirectional audio (inject audio into call)
   - Support for other formats (8kHz, ulaw, alaw)
   - Built-in VAD (Voice Activity Detection)
   - Transcription integration (Whisper, Google Speech)

---

## Summary

✅ **Core infrastructure complete**  
✅ **API endpoints functional**  
✅ **WebSocket event system in place**  
✅ **Documentation comprehensive**  
✅ **Code compiles and lints successfully**  

⚠️ **Audio frame emission needs WebSocket implementation**  
⚠️ **Testing required before production use**

The foundation for real-time audio capture is now in place. The next developer can focus on implementing the WebSocket audio streaming without worrying about the ARI integration, state management, or API structure.
