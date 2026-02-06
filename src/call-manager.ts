import { EventEmitter } from "node:events";
import type { CallRecord, CallState, CallEvent, BridgeRecord } from "./types.js";

/**
 * Manages active call and bridge state and emits events for the WebSocket stream.
 */
export class CallManager extends EventEmitter {
  private calls = new Map<string, CallRecord>();
  private bridges = new Map<string, BridgeRecord>();

  // ── Call management ───────────────────────────────────────────────

  create(record: CallRecord): void {
    this.calls.set(record.id, record);
    this.emit("call:created", record);
    this.emitCallEvent(record.id, "call.created", { state: record.state });
  }

  get(callId: string): CallRecord | undefined {
    return this.calls.get(callId);
  }

  getByChannelId(channelId: string): CallRecord | undefined {
    for (const call of this.calls.values()) {
      if (call.channelId === channelId) return call;
    }
    return undefined;
  }

  listActive(): CallRecord[] {
    return Array.from(this.calls.values()).filter(
      (c) => c.state !== "ended" && c.state !== "failed"
    );
  }

  updateState(callId: string, state: CallState, extra?: Partial<CallRecord>): void {
    const call = this.calls.get(callId);
    if (!call) return;

    const previousState = call.state;
    call.state = state;
    if (extra) Object.assign(call, extra);

    this.emitCallEvent(callId, "call.state_changed", {
      previousState,
      state,
      ...extra,
    });
  }

  setBridge(callId: string, bridgeId: string): void {
    const call = this.calls.get(callId);
    if (call) {
      call.bridgeId = bridgeId;
      call.state = "bridged";
    }
  }

  clearBridge(callId: string): void {
    const call = this.calls.get(callId);
    if (call) {
      call.bridgeId = undefined;
      if (call.state === "bridged") {
        call.state = "answered";
      }
    }
  }

  addRecording(callId: string, recordingName: string): void {
    const call = this.calls.get(callId);
    if (call) call.recordings.push(recordingName);
  }

  end(callId: string, cause?: string): void {
    const call = this.calls.get(callId);
    if (!call) return;

    call.state = "ended";
    call.endedAt = new Date();
    call.hangupCause = cause;

    this.emitCallEvent(callId, "call.ended", { cause });

    // Clean up after 5 minutes
    setTimeout(() => this.calls.delete(callId), 5 * 60 * 1000);
  }

  // ── Bridge management ─────────────────────────────────────────────

  createBridge(record: BridgeRecord): void {
    this.bridges.set(record.id, record);
    this.emit("event", {
      type: "bridge.created",
      callId: "",
      timestamp: new Date(),
      data: { bridgeId: record.id, name: record.name, type: record.type },
    } satisfies CallEvent);
  }

  getBridge(bridgeId: string): BridgeRecord | undefined {
    return this.bridges.get(bridgeId);
  }

  listBridges(): BridgeRecord[] {
    return Array.from(this.bridges.values());
  }

  addChannelToBridge(bridgeId: string, channelId: string): void {
    const bridge = this.bridges.get(bridgeId);
    if (bridge && !bridge.channelIds.includes(channelId)) {
      bridge.channelIds.push(channelId);
    }
  }

  removeChannelFromBridge(bridgeId: string, channelId: string): void {
    const bridge = this.bridges.get(bridgeId);
    if (bridge) {
      bridge.channelIds = bridge.channelIds.filter((id) => id !== channelId);
    }
  }

  deleteBridge(bridgeId: string): void {
    this.bridges.delete(bridgeId);
    this.emit("event", {
      type: "bridge.destroyed",
      callId: "",
      timestamp: new Date(),
      data: { bridgeId },
    } satisfies CallEvent);
  }

  // ── Events ────────────────────────────────────────────────────────

  private emitCallEvent(callId: string, type: string, data: Record<string, unknown>): void {
    const event: CallEvent = {
      type,
      callId,
      timestamp: new Date(),
      data,
    };
    this.emit("event", event);
  }
}
