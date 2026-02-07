# Audio Capture Feature (v0.2.0)

## Overview

The audio capture feature enables real-time audio streaming from active phone calls using Asterisk ARI. This is useful for:
- Real-time transcription
- Voice analysis and processing
- Call monitoring and quality assurance
- AI-powered voice assistants

## How It Works

The audio capture system uses a combination of ARI features:

1. **Snoop Channel**: Creates a monitoring channel that mirrors audio from the active call
2. **ExternalMedia Channel**: Streams the snooped audio out of Asterisk via WebSocket/RTP
3. **Bridge**: Connects the snoop channel to the ExternalMedia channel for audio flow

```
Active Call Channel
       ↓
  Snoop Channel (spy on audio)
       ↓
    Bridge
       ↓
ExternalMedia Channel (stream to Node.js)
       ↓
  Audio Frames → WebSocket clients
```

## Audio Format

- **Codec**: PCM 16-bit signed linear (slin16)
- **Sample Rate**: 16 kHz
- **Channels**: Mono
- **Frame Size**: ~100ms chunks (1600 samples @ 16kHz)
- **Direction**: Incoming audio from caller (configurable)

## API Usage

### Start Audio Capture

```bash
curl -X POST http://localhost:3456/calls/{callId}/audio/start
```

**Response:**
```json
{
  "audioCapture": {
    "enabled": true,
    "snoopChannelId": "snoop-...",
    "externalMediaChannelId": "audiocap-...",
    "format": "slin16",
    "sampleRate": 16000,
    "startedAt": "2026-02-07T05:00:00.000Z"
  }
}
```

### Stop Audio Capture

```bash
curl -X POST http://localhost:3456/calls/{callId}/audio/stop
```

**Response:** 204 No Content

## WebSocket Events

When audio capture is active, the following events are emitted via the `/events` WebSocket:

### `call.audio_capture_started`

Fired when audio capture begins.

```json
{
  "type": "call.audio_capture_started",
  "callId": "uuid",
  "timestamp": "2026-02-07T05:00:00.000Z",
  "data": {
    "enabled": true,
    "snoopChannelId": "snoop-...",
    "externalMediaChannelId": "audiocap-...",
    "format": "slin16",
    "sampleRate": 16000,
    "startedAt": "2026-02-07T05:00:00.000Z"
  }
}
```

### `call.audio_frame`

Emitted for each audio frame (approximately every 100ms).

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

**Note:** The `data` field contains base64-encoded raw PCM audio bytes.

### `call.audio_capture_stopped`

Fired when audio capture ends (manually or when call ends).

```json
{
  "type": "call.audio_capture_stopped",
  "callId": "uuid",
  "timestamp": "2026-02-07T05:01:00.000Z",
  "data": {}
}
```

### `call.audio_capture_error`

Fired if an error occurs during audio capture.

```json
{
  "type": "call.audio_capture_error",
  "callId": "uuid",
  "timestamp": "2026-02-07T05:00:30.000Z",
  "data": {
    "error": "Error description"
  }
}
```

## Decoding Audio Frames

To decode and process the audio frames in JavaScript/TypeScript:

```typescript
// WebSocket client
const ws = new WebSocket("ws://localhost:3456/events");

ws.on("message", (data) => {
  const event = JSON.parse(data.toString());

  if (event.type === "call.audio_frame") {
    const { data: frameData } = event.data;
    
    // Decode base64 to Buffer
    const pcmBuffer = Buffer.from(frameData, "base64");
    
    // pcmBuffer is raw PCM 16-bit signed little-endian samples
    // Convert to Float32Array for audio processing:
    const samples = new Int16Array(
      pcmBuffer.buffer,
      pcmBuffer.byteOffset,
      pcmBuffer.length / 2
    );
    
    // Convert to float [-1.0, 1.0]
    const floatSamples = new Float32Array(samples.length);
    for (let i = 0; i < samples.length; i++) {
      floatSamples[i] = samples[i] / 32768.0;
    }
    
    // Now you can:
    // - Send to speech-to-text API (e.g., Whisper, Google Speech)
    // - Analyze audio features
    // - Write to a WAV file
    // - Stream to audio processing pipeline
  }
});
```

## Python Example

```python
import websocket
import json
import base64
import numpy as np

def on_message(ws, message):
    event = json.loads(message)
    
    if event["type"] == "call.audio_frame":
        # Decode base64 PCM data
        pcm_data = base64.b64decode(event["data"]["data"])
        
        # Convert to numpy array (16-bit signed)
        samples = np.frombuffer(pcm_data, dtype=np.int16)
        
        # Normalize to float32 [-1.0, 1.0]
        float_samples = samples.astype(np.float32) / 32768.0
        
        # Process audio (e.g., send to Whisper for transcription)
        # transcribe(float_samples, sample_rate=16000)

ws = websocket.WebSocketApp(
    "ws://localhost:3456/events",
    on_message=on_message
)
ws.run_forever()
```

## Limitations & Notes

### Current Implementation Status

This v0.2.0 release provides the **infrastructure** for audio capture:
- ✅ ARI Snoop channel creation
- ✅ ExternalMedia channel setup
- ✅ Bridge configuration
- ✅ API endpoints and WebSocket events
- ⚠️ **Audio frame emission is currently a placeholder**

### Next Steps for Full Implementation

To complete the audio streaming pipeline, you need to:

1. **Connect to Asterisk's ExternalMedia WebSocket**:
   - Asterisk opens a WebSocket server for ExternalMedia channels
   - Connect to `ws://<asterisk-host>:8088/ari/events?app=openclaw-voice`
   - Handle binary audio frames from the WebSocket

2. **Process RTP/Raw Audio**:
   - If using RTP transport, set up an RTP listener
   - Parse RTP packets and extract audio payloads
   - Handle codec decoding (slin16 is raw PCM, no decoding needed)

3. **Emit Audio Frames**:
   - Once audio is received, emit `AudioFrame` events via the manager
   - The existing code will broadcast them to WebSocket clients

### Why ExternalMedia?

ExternalMedia channels allow Asterisk to stream audio to/from external applications via:
- **WebSocket** (simplest, binary frames)
- **RTP over UDP** (standard VoIP protocol)
- **AudioSocket over TCP** (custom protocol)

For this use case, **WebSocket** is recommended for simplicity.

### Asterisk Configuration

Ensure your Asterisk instance supports ExternalMedia (Asterisk 16.6+ / 17.1+):

```ini
; ari.conf
[general]
enabled = yes

[openclaw_ari]
type = user
password = your_password
read_only = no
```

No additional modules are required; ExternalMedia uses `chan_rtp.so` which is built-in.

## Testing

### Manual Test

1. Start the API server:
   ```bash
   npm run dev
   ```

2. Originate a call:
   ```bash
   curl -X POST http://localhost:3456/calls \
     -H "Content-Type: application/json" \
     -d '{"endpoint": "PJSIP/1001"}'
   ```

3. Get the call ID from the response, then start audio capture:
   ```bash
   curl -X POST http://localhost:3456/calls/{callId}/audio/start
   ```

4. Connect a WebSocket client to monitor events:
   ```bash
   websocat ws://localhost:3456/events
   ```

5. You should see `call.audio_capture_started` event

6. Stop audio capture:
   ```bash
   curl -X POST http://localhost:3456/calls/{callId}/audio/stop
   ```

### Automated Test

A test script is planned for future releases.

## Security Considerations

- Audio capture creates additional channels and bridges, consuming Asterisk resources
- Audio frames are transmitted over WebSocket in base64 — ensure WSS (WebSocket Secure) in production
- Consider implementing rate limiting on audio capture endpoints
- Monitor system resources when capturing multiple simultaneous calls

## Performance

Each audio capture session:
- Creates 2 additional Asterisk channels (snoop + ExternalMedia)
- Creates 1 bridge
- Generates ~10 events/second (100ms frames)
- Bandwidth: ~32 KB/s per call (16kHz mono PCM)

Plan capacity accordingly for multi-call environments.

## Troubleshooting

### Error: "Audio capture manager not initialized"

The ARI connection is not active. Check:
- Asterisk is running and reachable
- ARI credentials are correct in `.env`
- `/health` endpoint shows `ari.connected: true`

### No audio frames received

This is expected in v0.2.0 — audio frame emission is a placeholder. To receive real audio:
- Implement WebSocket connection to Asterisk's ExternalMedia endpoint
- See "Next Steps for Full Implementation" above

### Snoop channel creation fails

- Ensure the target channel is in Stasis (the call must be active)
- Check Asterisk logs: `asterisk -rvvv`
- Verify the channel ID is correct

## Future Enhancements

- [ ] Complete WebSocket audio streaming from ExternalMedia channel
- [ ] Support for bidirectional audio (inject audio into call)
- [ ] Audio format options (8kHz, ulaw, alaw)
- [ ] Automatic VAD (Voice Activity Detection)
- [ ] Built-in transcription integration (Whisper, Google Speech)
- [ ] Audio recording to file alongside real-time streaming
- [ ] Multi-party conference audio mixing

## References

- [Asterisk ARI Documentation](https://docs.asterisk.org/Asterisk_21_Documentation/API_Documentation/Asterisk_REST_Interface/)
- [ARI Channels API](https://docs.asterisk.org/Asterisk_21_Documentation/API_Documentation/Asterisk_REST_Interface/Channels_REST_API/)
- [Snoop API](https://docs.asterisk.org/Asterisk_21_Documentation/API_Documentation/Asterisk_REST_Interface/Channels_REST_API/#snoopchannel)
- [ExternalMedia API](https://docs.asterisk.org/Asterisk_21_Documentation/API_Documentation/Asterisk_REST_Interface/Channels_REST_API/#externalmedia)
