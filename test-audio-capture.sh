#!/bin/bash
# Quick test script for audio capture feature

set -e

API_BASE="http://localhost:3456"
CALL_ID=""

echo "🎙️  Audio Capture Test Script"
echo "=============================="
echo ""

# Step 1: Check API health
echo "1️⃣  Checking API health..."
curl -s "$API_BASE/health" | jq '.'
echo ""

# Step 2: Originate a call
echo "2️⃣  Originating a test call to PJSIP/1001..."
RESPONSE=$(curl -s -X POST "$API_BASE/calls" \
  -H "Content-Type: application/json" \
  -d '{"endpoint": "PJSIP/1001", "timeout": 30}')

CALL_ID=$(echo "$RESPONSE" | jq -r '.call.id')

if [ -z "$CALL_ID" ] || [ "$CALL_ID" = "null" ]; then
  echo "❌ Failed to originate call"
  echo "$RESPONSE" | jq '.'
  exit 1
fi

echo "✅ Call originated: $CALL_ID"
echo ""

# Step 3: Wait for call to be answered
echo "3️⃣  Waiting 3 seconds for call to be answered..."
sleep 3

# Check call status
CALL_STATUS=$(curl -s "$API_BASE/calls/$CALL_ID" | jq -r '.call.state')
echo "   Call state: $CALL_STATUS"
echo ""

# Step 4: Start audio capture
echo "4️⃣  Starting audio capture..."
AUDIO_RESPONSE=$(curl -s -X POST "$API_BASE/calls/$CALL_ID/audio/start")
echo "$AUDIO_RESPONSE" | jq '.'

SNOOP_ID=$(echo "$AUDIO_RESPONSE" | jq -r '.audioCapture.snoopChannelId')

if [ -z "$SNOOP_ID" ] || [ "$SNOOP_ID" = "null" ]; then
  echo "❌ Failed to start audio capture"
  exit 1
fi

echo "✅ Audio capture started"
echo "   Snoop channel: $SNOOP_ID"
echo ""

# Step 5: Monitor for a few seconds
echo "5️⃣  Audio capture is active..."
echo "   (In production, audio frames would be streaming via WebSocket)"
echo "   Waiting 5 seconds..."
sleep 5

# Step 6: Stop audio capture
echo ""
echo "6️⃣  Stopping audio capture..."
curl -s -X POST "$API_BASE/calls/$CALL_ID/audio/stop"
echo "✅ Audio capture stopped"
echo ""

# Step 7: Hang up the call
echo "7️⃣  Hanging up call..."
curl -s -X DELETE "$API_BASE/calls/$CALL_ID"
echo "✅ Call ended"
echo ""

echo "=============================="
echo "✅ Test complete!"
echo ""
echo "Next steps:"
echo "  1. Connect a WebSocket client to ws://localhost:3456/events"
echo "  2. Run this test again and watch for audio capture events"
echo "  3. Implement WebSocket audio streaming (see AUDIO_CAPTURE.md)"
