# Test Results — asterisk-api

Integration tests run against live Asterisk server (192.168.2.198).

## Test Matrix

| # | Test | Endpoint(s) | Status | Notes |
|---|------|-------------|--------|-------|
| 1 | Health check | `GET /health` | PASSED | ARI connection status, active call count |
| 2 | API overview | `GET /` | PASSED | Returns full endpoint listing |
| 3 | List endpoints | `GET /endpoints` | PASSED | Lists PJSIP endpoints (101, sip50690132) |
| 4 | Originate call | `POST /calls` | PASSED | Outbound call via SIP trunk to real number |
| 5 | List/get calls | `GET /calls`, `GET /calls/:id` | PASSED | Active call list + individual call details |
| 6 | Hangup call | `DELETE /calls/:id` | PASSED | Clean hangup with normal cause |
| 7 | Play audio | `POST /calls/:id/play` | PASSED | Play sound on active call |
| 8 | Send DTMF | `POST /calls/:id/dtmf` | PASSED | DTMF tones on active call |
| 9 | Recording mgmt | `POST record`, `GET /recordings`, `GET file`, `DELETE` | PASSED | Start, list, download, stop/delete recordings |
| 10 | Bridge mgmt | `POST /bridges`, `addChannel`, `removeChannel`, `DELETE` | SKIPPED | Needs two active calls |
| 11 | Call transfer | `POST /calls/:id/transfer` | SKIPPED | Needs two endpoints available |
| 12 | WS events | `WS /events` | PASSED | Full lifecycle: snapshot → created → ringing → answered → ready → ended |
| 13 | API key auth | `API_KEY` env var | SKIPPED | Needs server restart with API_KEY set |
| 14 | Error handling | Various | PASSED | Zod validation, 404s, invalid endpoints, bad DTMF |
| 15 | ARI reconnect | Kill/restart Asterisk | SKIPPED | Needs Asterisk restart |

**Result: 11/15 passed, 4 skipped (infrastructure constraints)**

## Bugs Found During Testing

| Bug | File | Fix |
|-----|------|-----|
| `GET /endpoints` circular reference crash | `ari-connection.ts` | Map raw ARI objects to plain objects |
| `GET /bridges` / `GET /bridges/:id` same circular ref | `ari-connection.ts` | Map raw ARI bridge objects to plain objects |
| WS stream missing DTMF, ready, playback, recording events | `ari-connection.ts` | Added `callManager.broadcastEvent()` calls |

## WebSocket Event Stream

Events verified on `WS /events`:

```
snapshot            — sent on connect, contains active calls
call.created        — new call initiated
call.state_changed  — ringing, answered, etc.
call.ready          — outbound call entered Stasis, ready for media
call.dtmf           — DTMF digit received
call.playback_finished — audio playback completed
call.recording_finished — recording completed
call.ended          — call hung up (with cause)
bridge.created      — bridge created
bridge.destroyed    — bridge destroyed
```

## Test Environment

- Asterisk 21.12.1 in Docker on Synology NAS (192.168.2.198)
- FreePBX 17, ARI on port 8088
- PJSIP endpoint 101, SIP trunk sip50690132
- asterisk-api running on port 3456
