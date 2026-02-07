# ASR Integration Testing Guide (v0.2.1)

## Overview

Version 0.2.1 completes the audio → ASR → transcription pipeline:

1. **Audio Capture**: Snoop + ExternalMedia channels capture call audio
2. **Audio Streaming**: WebSocket connection receives PCM audio frames from Asterisk
3. **ASR Processing**: Audio frames sent to ASR service at `ws://192.168.2.198:8100/ws/transcribe`
4. **Transcription**: Real-time transcriptions broadcast via WebSocket

## Prerequisites

1. **ASR Service Running**:
   ```bash
   # Verify ASR service is available
   curl http://192.168.2.198:8100/health
   # Should return 200 OK
   ```

2. **Asterisk ARI Connected**:
   ```bash
   curl http://localhost:3456/health
   # Should show "ari": true
   ```

3. **WebSocket Client** (for monitoring events):
   ```bash
   # Install websocat if needed
   brew install websocat
   # Or use wscat: npm install -g wscat
   ```

## Testing Steps

### 1. Monitor WebSocket Events

In one terminal, connect to the event stream:

```bash
websocat ws://localhost:3456/events
# Or: wscat -c ws://localhost:3456/events
```

You should see a connection confirmation message.

### 2. Originate a Test Call

In another terminal:

```bash
# Start a call to a SIP endpoint
curl -X POST http://localhost:3456/calls \
  -H "Content-Type: application/json" \
  -d '{
    "endpoint": "PJSIP/1001",
    "callerId": "openclaw-test"
  }'
```

**Expected response:**
```json
{
  "id": "uuid-here",
  "channelId": "channel-id",
  "state": "ringing",
  "direction": "outbound",
  ...
}
```

Save the `id` value — this is your `callId`.

### 3. Start Audio Capture

Once the call is answered (watch WebSocket for `call.answered` event):

```bash
curl -X POST http://localhost:3456/calls/{callId}/audio/start
```

**Expected response:**
```json
{
  "audioCapture": {
    "enabled": true,
    "snoopChannelId": "snoop-...",
    "externalMediaChannelId": "audiocap-...",
    "format": "slin16",
    "sampleRate": 16000,
    "startedAt": "2026-02-07T14:00:00.000Z"
  }
}
```

### 4. Monitor WebSocket Events

In your WebSocket terminal, you should see:

```json
{
  "type": "call.audio_capture_started",
  "callId": "uuid-here",
  "timestamp": "...",
  "data": {
    "enabled": true,
    "snoopChannelId": "snoop-...",
    ...
  }
}
```

Followed by:

```json
{
  "type": "call.audio_frame",
  "callId": "uuid-here",
  "timestamp": "...",
  "data": {
    "timestamp": 1707312000000,
    "format": "slin16",
    "sampleRate": 16000,
    "channels": 1,
    "sampleCount": 1600,
    "data": "base64-encoded-audio..."
  }
}
```

And most importantly:

```json
{
  "type": "call.transcription",
  "callId": "uuid-here",
  "timestamp": "...",
  "data": {
    "text": "Hello, this is a test",
    "is_partial": false,
    "is_final": true
  }
}
```

### 5. Speak into the Call

Have someone speak on the call (or use a test audio source). The ASR service should:
- Receive audio frames in real-time
- Send partial transcriptions as speech is detected
- Send final transcriptions when speech segments complete

### 6. Stop Audio Capture

```bash
curl -X POST http://localhost:3456/calls/{callId}/audio/stop
```

**Expected WebSocket event:**
```json
{
  "type": "call.audio_capture_stopped",
  "callId": "uuid-here",
  ...
}
```

### 7. End the Call

```bash
curl -X DELETE http://localhost:3456/calls/{callId}
```

## Troubleshooting

### No audio frames received

**Check server logs** for:
```
[AudioCapture] Connected to ExternalMedia WebSocket for call ...
```

If you see errors:
- Verify Asterisk ARI WebSocket is accessible
- Check ARI credentials in `.env`
- Ensure ExternalMedia channel creation succeeded

### No transcriptions

**Check server logs** for:
```
[AsrClient] Connected to ASR service for call ...
[AsrClient] Transcription for call ...: "text here"
```

If no connection:
- Verify ASR service is running: `curl http://192.168.2.198:8100/health`
- Check network connectivity to ASR service
- Look for WebSocket connection errors in logs

If connected but no transcriptions:
- Verify audio frames are being sent to ASR
- Check ASR service logs for errors
- Ensure audio format is correct (PCM 16-bit, 16kHz mono)

### ASR keeps reconnecting

**Check logs for:**
```
[AsrClient] WebSocket closed for call ... (code: 1006, reason: ...)
[AsrClient] Scheduling reconnect attempt ...
```

Common causes:
- ASR service crashed or restarted
- Network interruption
- ASR service rejected the connection

By default, ASR client will retry up to 10 times before giving up.

### Audio frames but garbled/wrong format

Verify in server logs:
```
[AudioCapture] Created ExternalMedia channel: audiocap-...
format: slin16
sampleRate: 16000
```

If format is wrong:
- Check `AudioCaptureManager` initialization in `ari-connection.ts`
- Ensure Asterisk supports slin16 codec

## Expected Log Flow

When everything works correctly:

```
[ARI] Audio capture started for call abc-123
[AudioCapture] Connecting to ExternalMedia WebSocket: ws://...
[AudioCapture] Connected to ExternalMedia WebSocket for call abc-123
[ARI] Starting ASR session for call abc-123
[AsrClient] Connecting to ws://192.168.2.198:8100/ws/transcribe for call abc-123
[AsrClient] Connected to ASR service for call abc-123
[ARI] ASR session connected for call abc-123

... (audio frames streaming) ...

[AsrClient] Transcription for call abc-123: "hello world" (partial: true, final: false)
[ARI] Transcription for call abc-123: "hello world" (partial: true, final: false)
[AsrClient] Transcription for call abc-123: "hello world how are you" (partial: false, final: true)
[ARI] Transcription for call abc-123: "hello world how are you" (partial: false, final: true)

... (more transcriptions) ...

[ARI] Audio capture stopped for call abc-123
[AsrClient] Sent control command "flush" for call abc-123
[AsrClient] Closing ASR connection for call abc-123
[AudioCapture] Closing ExternalMedia WebSocket for call abc-123
```

## Testing with Real Calls

### Inbound Call Test

1. Make sure inbound caller is in allowlist (`allowlist.json`)
2. Call your FreePBX number from a phone
3. Wait for auto-answer
4. Start audio capture: `POST /calls/{callId}/audio/start`
5. Speak into the phone
6. Monitor WebSocket for transcriptions

### Outbound Call Test

1. Originate call to a test endpoint
2. Wait for answer
3. Start audio capture
4. Play audio via `POST /calls/{callId}/play` (optional)
5. If bidirectional: speak on the other end
6. Monitor transcriptions

## Architecture Summary

```
Phone Call
    ↓
Asterisk Channel
    ↓
Snoop Channel (spy=in)
    ↓
Bridge (mixing)
    ↓
ExternalMedia Channel (websocket, slin16)
    ↓
Asterisk WebSocket Server
    ↓
Node.js AudioCapture Client
    ↓
    ├─→ WebSocket Clients (base64 JSON)
    └─→ ASR Client (binary PCM)
          ↓
      ASR Service (ws://192.168.2.198:8100/ws/transcribe)
          ↓
      Transcription Results
          ↓
      WebSocket Clients (call.transcription event)
```

## Performance Notes

- **Audio Frame Rate**: ~10 frames/second (100ms chunks at 16kHz)
- **Bandwidth**: ~32 KB/s per call (16kHz mono PCM)
- **Latency**: ASR typically adds 100-500ms depending on service
- **Partial Transcriptions**: Enable lower perceived latency

## Next Steps

- Test with multiple simultaneous calls
- Monitor resource usage (CPU, memory, network)
- Implement error recovery strategies
- Add metrics/monitoring for production use
- Consider audio buffering for ASR reliability
