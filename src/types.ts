export type CallState =
  | "initiating"
  | "ringing"
  | "answered"
  | "playing"
  | "recording"
  | "bridged"
  | "ended"
  | "failed";

export interface CallRecord {
  id: string;
  channelId: string;
  bridgeId?: string;
  state: CallState;
  direction: "inbound" | "outbound";
  callerNumber: string;
  calleeNumber: string;
  createdAt: Date;
  answeredAt?: Date;
  endedAt?: Date;
  hangupCause?: string;
  recordings: string[];
}

export interface CallEvent {
  type: string;
  callId: string;
  timestamp: Date;
  data: Record<string, unknown>;
}

export interface OriginateRequest {
  endpoint: string;
  callerId?: string;
  timeout?: number;
  variables?: Record<string, string>;
}

export interface PlayRequest {
  media: string;
}

export interface RecordRequest {
  name?: string;
  format?: string;
  maxDurationSeconds?: number;
  beep?: boolean;
}

export interface BridgeRecord {
  id: string;
  name?: string;
  type: string;
  channelIds: string[];
  createdAt: Date;
}

export interface TransferRequest {
  endpoint: string;
  callerId?: string;
  timeout?: number;
}
