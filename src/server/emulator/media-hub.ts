import type { AudioChunk, MediaSink, VideoPacket } from 'node-mgba';
import WebSocket from 'ws';
import { AUDIO_TARGET_SAMPLE_RATE } from '../../shared/emulator-status';
import { encodeAudioChunk, encodeVideoFrame } from '../../shared/media-protocol';
import type { Logger } from '../logger';

/**
 * A slow or stalled client is skipped once this much data is queued. At GBA
 * rates this is roughly a quarter second of video, so latency stays bounded
 * without dropping healthy local clients.
 */
const MAX_BUFFERED_BYTES = 2 * 1024 * 1024;

type MediaKind = 'video' | 'audio';

/** Broadcasts binary media to connected WebSocket clients and owns counters. */
export class MediaHub implements MediaSink {
  readonly name = 'media-hub';

  videoFrames = 0;
  audioChunks = 0;
  droppedVideoFrames = 0;
  droppedAudioChunks = 0;
  lastFrameIndex = 0;
  audioSampleRate = AUDIO_TARGET_SAMPLE_RATE;

  private readonly clients = new Set<WebSocket>();
  private readonly logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  resetCounters(): void {
    this.videoFrames = 0;
    this.audioChunks = 0;
    this.droppedVideoFrames = 0;
    this.droppedAudioChunks = 0;
    this.lastFrameIndex = 0;
    this.audioSampleRate = AUDIO_TARGET_SAMPLE_RATE;
  }

  /** Aligns the observable frame counter with a restored core state. */
  setLastFrameIndex(frameIndex: number): void {
    if (Number.isFinite(frameIndex) && frameIndex >= 0) this.lastFrameIndex = frameIndex;
  }

  attachClient(socket: WebSocket): void {
    if (this.clients.has(socket)) return;
    this.clients.add(socket);
    socket.once('close', () => {
      this.clients.delete(socket);
    });
  }

  onVideoFrame(packet: VideoPacket): void {
    this.videoFrames += 1;
    this.lastFrameIndex = packet.frameIndex;

    try {
      this.broadcast(
        encodeVideoFrame({
          frameIndex: packet.frameIndex,
          pts: packet.pts,
          width: packet.width,
          height: packet.height,
          strideBytes: packet.strideBytes,
          buffer: packet.buffer,
        }),
        'video',
      );
    } catch (error) {
      this.droppedVideoFrames += 1;
      this.logger.debug(`dropped malformed video frame: ${(error as Error).message}`);
    }
  }

  onAudioChunk(chunk: AudioChunk): void {
    this.audioChunks += 1;
    this.audioSampleRate = chunk.sampleRate;

    try {
      this.broadcast(
        encodeAudioChunk({
          frameIndex: chunk.frameIndex,
          pts: chunk.pts,
          sampleRate: chunk.sampleRate,
          channels: chunk.channels,
          sampleFrames: chunk.sampleFrames,
          buffer: chunk.buffer,
        }),
        'audio',
      );
    } catch (error) {
      this.droppedAudioChunks += 1;
      this.logger.debug(`dropped malformed audio chunk: ${(error as Error).message}`);
    }
  }

  private broadcast(message: Uint8Array, kind: MediaKind): void {
    for (const client of this.clients) {
      if (client.readyState === WebSocket.CLOSING || client.readyState === WebSocket.CLOSED) {
        this.clients.delete(client);
        continue;
      }
      if (client.readyState !== WebSocket.OPEN) continue;

      if (client.bufferedAmount > MAX_BUFFERED_BYTES) {
        this.recordDrop(kind);
        continue;
      }

      try {
        client.send(message);
      } catch {
        this.recordDrop(kind);
      }
    }
  }

  private recordDrop(kind: MediaKind): void {
    if (kind === 'video') this.droppedVideoFrames += 1;
    else this.droppedAudioChunks += 1;
  }
}
