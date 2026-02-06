# Methods Map — asterisk-api ↔ Asterisk ARI

Maps each REST API endpoint to its `AriConnection` method and underlying ARI client call.

## Call Management

| REST API | Method | HTTP | ARI Client Call | ARI HTTP Equivalent |
|----------|--------|------|-----------------|---------------------|
| `/calls` | `originate()` | POST | `channel.originate()` | `POST /ari/channels` |
| `/calls` | `listActive()` | GET | — (in-memory) | — |
| `/calls/:id` | `get()` | GET | — (in-memory) | — |
| `/calls/:id` | `hangup()` | DELETE | `ari.channels.hangup()` | `DELETE /ari/channels/{id}` |
| `/calls/:id/dtmf` | `sendDtmf()` | POST | `ari.channels.sendDTMF()` | `POST /ari/channels/{id}/dtmf` |
| `/calls/:id/transfer` | `transferCall()` | POST | `bridges.create()` + `originate()` + `bridges.addChannel()` | Composite operation |

## Audio Playback

| REST API | Method | HTTP | ARI Client Call | ARI HTTP Equivalent |
|----------|--------|------|-----------------|---------------------|
| `/calls/:id/play` | `playMedia()` | POST | `ari.channels.play()` | `POST /ari/channels/{id}/play` |
| `/calls/:id/play` (array) | `playMediaSequence()` | POST | `ari.channels.play()` × N | Sequential `POST /ari/channels/{id}/play` |
| `/calls/:id/play/file` | `uploadAndPlayFile()` | POST | `fetch PUT /ari/sounds/{name}` + `channels.play()` | `PUT /ari/sounds/{name}` + `POST /ari/channels/{id}/play` |

## Recording

| REST API | Method | HTTP | ARI Client Call | ARI HTTP Equivalent |
|----------|--------|------|-----------------|---------------------|
| `/calls/:id/record` | `startRecording()` | POST | `ari.channels.record()` | `POST /ari/channels/{id}/record` |
| `/recordings` | `listStoredRecordings()` | GET | `ari.recordings.listStored()` | `GET /ari/recordings/stored` |
| `/recordings/:name` | `getStoredRecording()` | GET | `ari.recordings.getStored()` | `GET /ari/recordings/stored/{name}` |
| `/recordings/:name/file` | `getRecordingFile()` | GET | `ari.recordings.getStoredFile()` | `GET /ari/recordings/stored/{name}/file` |
| `/recordings/:name/copy` | `copyStoredRecording()` | POST | `ari.recordings.copyStored()` | `POST /ari/recordings/stored/{name}/copy` |
| `/recordings/:name` | `stopRecording()` | DELETE | `ari.recordings.stop()` | `POST /ari/recordings/live/{name}/stop` |
| `/recordings/:name?stored=true` | `deleteStoredRecording()` | DELETE | `ari.recordings.deleteStored()` | `DELETE /ari/recordings/stored/{name}` |

## Bridge Management

| REST API | Method | HTTP | ARI Client Call | ARI HTTP Equivalent |
|----------|--------|------|-----------------|---------------------|
| `/bridges` | `createBridge()` | POST | `ari.bridges.create()` | `POST /ari/bridges` |
| `/bridges` | `listBridges()` | GET | `ari.bridges.list()` | `GET /ari/bridges` |
| `/bridges/:id` | `getBridge()` | GET | `ari.bridges.get()` | `GET /ari/bridges/{id}` |
| `/bridges/:id` | `destroyBridge()` | DELETE | `ari.bridges.destroy()` | `DELETE /ari/bridges/{id}` |
| `/bridges/:id/addChannel` | `addChannelToBridge()` | POST | `ari.bridges.addChannel()` | `POST /ari/bridges/{id}/addChannel` |
| `/bridges/:id/removeChannel` | `removeChannelFromBridge()` | POST | `ari.bridges.removeChannel()` | `POST /ari/bridges/{id}/removeChannel` |

## Endpoints

| REST API | Method | HTTP | ARI Client Call | ARI HTTP Equivalent |
|----------|--------|------|-----------------|---------------------|
| `/endpoints` | `listEndpoints()` | GET | `ari.endpoints.list()` | `GET /ari/endpoints` |
| — (internal) | `checkEndpoint()` | — | `ari.endpoints.get()` | `GET /ari/endpoints/{tech}/{resource}` |

## Infrastructure (no REST endpoint)

| Method | ARI Client Call | Purpose |
|--------|-----------------|---------|
| `connect()` | `ariClient.connect()` + `ari.start()` | Establish ARI WebSocket + REST connection |
| `disconnect()` | `ari.stop()` | Close ARI connection |

## ARI Event Handlers

| ARI Event | Handler Action | Downstream Event |
|-----------|---------------|------------------|
| `StasisStart` (inbound) | Create call record, auto-answer | `call.created` (WS) + `call.inbound` (webhook) |
| `StasisStart` (outbound) | Mark call ready for media | `call.ready` (WS + webhook) |
| `StasisEnd` | End call record | `call.ended` (WS + webhook) |
| `ChannelStateChange` | Update call state (ringing→answered) | `call.state_changed` (WS) + `call.answered` (webhook) |
| `ChannelDtmfReceived` | Log digit | `call.dtmf` (WS + webhook) |
| `PlaybackFinished` | Resolve play promise | `call.playback_finished` (WS) |
| `RecordingFinished` | Log completion | `call.recording_finished` (WS) |
| `WebSocketReconnecting` | Mark disconnected | — |
| `WebSocketConnected` | Mark connected | — |
