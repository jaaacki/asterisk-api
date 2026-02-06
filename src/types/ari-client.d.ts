declare module "ari-client" {
  interface AriClient {
    start(app: string): void;
    stop(): void;
    on(event: string, handler: (...args: any[]) => void): void;
    Channel(): AriChannel;
    Bridge(): AriBridge;
    Playback(): AriPlayback;
    LiveRecording(): AriLiveRecording;
    channels: AriChannelsApi;
    bridges: AriBridgesApi;
    recordings: AriRecordingsApi;
    playbacks: AriPlaybacksApi;
    sounds: AriSoundsApi;
    endpoints: AriEndpointsApi;
  }

  interface AriChannel {
    id: string;
    name: string;
    state: string;
    caller: { name: string; number: string };
    connected: { name: string; number: string };
    dialplan: { context: string; exten: string; priority: number };
    on(event: string, handler: (...args: any[]) => void): void;
    answer(): Promise<void>;
    hangup(params?: { reason?: string }): Promise<void>;
    play(params: { media: string }, playback?: AriPlayback): Promise<AriPlayback>;
    record(params: RecordParams): Promise<AriLiveRecording>;
    originate(params: OriginateParams): Promise<AriChannel>;
    sendDTMF(params: { dtmf: string }): Promise<void>;
  }

  interface AriBridge {
    id: string;
    on(event: string, handler: (...args: any[]) => void): void;
    create(params: { type: string; name?: string }): Promise<AriBridge>;
    addChannel(params: { channel: string | string[] }): Promise<void>;
    removeChannel(params: { channel: string }): Promise<void>;
    destroy(): Promise<void>;
    play(params: { media: string }, playback?: AriPlayback): Promise<AriPlayback>;
  }

  interface AriPlayback {
    id: string;
    on(event: string, handler: (...args: any[]) => void): void;
  }

  interface AriLiveRecording {
    name: string;
    on(event: string, handler: (...args: any[]) => void): void;
  }

  interface AriChannelsApi {
    list(): Promise<AriChannel[]>;
    get(params: { channelId: string }): Promise<AriChannel>;
    hangup(params: { channelId: string; reason?: string }): Promise<void>;
    answer(params: { channelId: string }): Promise<void>;
    play(params: { channelId: string; media: string }, playback?: AriPlayback): Promise<AriPlayback>;
    record(params: { channelId: string } & RecordParams): Promise<AriLiveRecording>;
    sendDTMF(params: { channelId: string; dtmf: string }): Promise<void>;
    originate(params: OriginateParams): Promise<AriChannel>;
  }

  interface AriBridgesApi {
    list(): Promise<AriBridge[]>;
    create(params: { type: string; name?: string }): Promise<AriBridge>;
    get(params: { bridgeId: string }): Promise<AriBridge>;
    destroy(params: { bridgeId: string }): Promise<void>;
    addChannel(params: { bridgeId: string; channel: string | string[] }): Promise<void>;
    removeChannel(params: { bridgeId: string; channel: string }): Promise<void>;
  }

  interface AriRecordingsApi {
    stop(params: { recordingName: string }): Promise<void>;
    getStored(params: { recordingName: string }): Promise<any>;
    getStoredFile(params: { recordingName: string }): Promise<Buffer>;
    listStored(): Promise<any[]>;
    deleteStored(params: { recordingName: string }): Promise<void>;
    copyStored(params: { recordingName: string; destinationRecordingName: string }): Promise<any>;
  }

  interface AriPlaybacksApi {
    get(params: { playbackId: string }): Promise<AriPlayback>;
    stop(params: { playbackId: string }): Promise<void>;
    control(params: { playbackId: string; operation: string }): Promise<void>;
  }

  interface AriSoundsApi {
    list(params?: { lang?: string }): Promise<any[]>;
    get(params: { soundId: string }): Promise<any>;
  }

  interface AriEndpointsApi {
    list(): Promise<any[]>;
    get(params: { tech: string; resource: string }): Promise<any>;
  }

  interface OriginateParams {
    endpoint: string;
    app?: string;
    appArgs?: string;
    callerId?: string;
    timeout?: number;
    extension?: string;
    context?: string;
    priority?: number;
    variables?: Record<string, any>;
  }

  interface RecordParams {
    name: string;
    format: string;
    maxDurationSeconds?: number;
    maxSilenceSeconds?: number;
    ifExists?: "fail" | "overwrite" | "append";
    beep?: boolean;
    terminateOn?: "none" | "any" | "*" | "#";
  }

  function connect(url: string, username: string, password: string): Promise<AriClient>;

  export default { connect };
  export { AriClient, AriChannel, AriBridge, AriPlayback, AriLiveRecording };
}
