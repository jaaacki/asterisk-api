import { EventEmitter } from "node:events";
import type { CallRecord, CallState, CallEvent } from "./types.js";

/**
 * Manages active call state and emits events for the WebSocket stream.
 */
export class CallManager extends EventEmitter {
  private calls = new Map<string, CallRecord>();

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
    if (call) call.bridgeId = bridgeId;
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
