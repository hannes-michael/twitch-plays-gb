/**
 * Binary WebSocket media protocol, v1.
 *
 * Everything is little-endian. The 28-byte header is:
 *   u16 magic (0x5450 "TP"), u8 version, u8 type, u32 frameIndex,
 *   u32 fieldA, u32 fieldB, u32 fieldC, f64 pts; then the payload.
 *
 * Video payload: fieldA=width, fieldB=height, fieldC=strideBytes,
 *   followed by strideBytes*height bytes of RGBA data.
 * Audio payload: fieldA=sampleRate, fieldB=channels, fieldC=sampleFrames,
 *   followed by sampleFrames*channels*2 bytes of S16LE interleaved PCM.
 *
 * This module is browser-safe: no Node built-ins and no emulator imports.
 */

export const MEDIA_PROTOCOL_VERSION = 1;
export const MEDIA_MAGIC = 0x5450;
export const MEDIA_HEADER_SIZE = 28;

export const MEDIA_MESSAGE_TYPE = {
  video: 1,
  audio: 2,
} as const;

export interface VideoFrameInput {
  frameIndex: number;
  pts: number;
  width: number;
  height: number;
  strideBytes: number;
  buffer: Uint8Array;
}

export interface AudioChunkInput {
  frameIndex: number;
  pts: number;
  sampleRate: number;
  channels: number;
  sampleFrames: number;
  buffer: Uint8Array;
}

export interface DecodedVideoFrame {
  type: 'video';
  frameIndex: number;
  pts: number;
  width: number;
  height: number;
  strideBytes: number;
  payload: Uint8Array;
}

export interface DecodedAudioChunk {
  type: 'audio';
  frameIndex: number;
  pts: number;
  sampleRate: number;
  channels: number;
  sampleFrames: number;
  payload: Uint8Array;
}

export type DecodedMediaMessage = DecodedVideoFrame | DecodedAudioChunk;

function isNonNegativeInteger(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}

function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

function writeHeader(
  type: number,
  frameIndex: number,
  fieldA: number,
  fieldB: number,
  fieldC: number,
  pts: number,
  payloadLength: number,
): Uint8Array {
  const bytes = new Uint8Array(MEDIA_HEADER_SIZE + payloadLength);
  const view = new DataView(bytes.buffer);

  view.setUint16(0, MEDIA_MAGIC, true);
  view.setUint8(2, MEDIA_PROTOCOL_VERSION);
  view.setUint8(3, type);
  view.setUint32(4, frameIndex >>> 0, true);
  view.setUint32(8, fieldA >>> 0, true);
  view.setUint32(12, fieldB >>> 0, true);
  view.setUint32(16, fieldC >>> 0, true);
  view.setFloat64(20, pts, true);

  return bytes;
}

export function encodeVideoFrame(frame: VideoFrameInput): Uint8Array {
  if (
    !isNonNegativeInteger(frame.frameIndex) ||
    !isPositiveInteger(frame.width) ||
    !isPositiveInteger(frame.height) ||
    !isPositiveInteger(frame.strideBytes) ||
    frame.strideBytes < frame.width * 4
  ) {
    throw new TypeError('Invalid video frame metadata');
  }

  const payloadLength = frame.strideBytes * frame.height;
  if (frame.buffer.byteLength < payloadLength) {
    throw new TypeError('Video frame buffer is shorter than strideBytes * height');
  }

  const bytes = writeHeader(
    MEDIA_MESSAGE_TYPE.video,
    frame.frameIndex,
    frame.width,
    frame.height,
    frame.strideBytes,
    frame.pts,
    payloadLength,
  );
  bytes.set(frame.buffer.subarray(0, payloadLength), MEDIA_HEADER_SIZE);
  return bytes;
}

export function encodeAudioChunk(chunk: AudioChunkInput): Uint8Array {
  if (
    !isNonNegativeInteger(chunk.frameIndex) ||
    !isPositiveInteger(chunk.sampleRate) ||
    !isPositiveInteger(chunk.channels) ||
    !isPositiveInteger(chunk.sampleFrames)
  ) {
    throw new TypeError('Invalid audio chunk metadata');
  }

  const payloadLength = chunk.sampleFrames * chunk.channels * 2;
  if (chunk.buffer.byteLength < payloadLength) {
    throw new TypeError('Audio chunk buffer is shorter than sampleFrames * channels * 2');
  }

  const bytes = writeHeader(
    MEDIA_MESSAGE_TYPE.audio,
    chunk.frameIndex,
    chunk.sampleRate,
    chunk.channels,
    chunk.sampleFrames,
    chunk.pts,
    payloadLength,
  );
  bytes.set(chunk.buffer.subarray(0, payloadLength), MEDIA_HEADER_SIZE);
  return bytes;
}

/**
 * Returns null for malformed, unsupported, or truncated messages. The returned
 * payload is a view into the input buffer; callers must not mutate it.
 */
export function decodeMediaMessage(
  data: ArrayBuffer | ArrayBufferView,
): DecodedMediaMessage | null {
  const bytes =
    data instanceof ArrayBuffer
      ? new Uint8Array(data)
      : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);

  if (bytes.byteLength < MEDIA_HEADER_SIZE) return null;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint16(0, true) !== MEDIA_MAGIC) return null;
  if (view.getUint8(2) !== MEDIA_PROTOCOL_VERSION) return null;

  const type = view.getUint8(3);
  const frameIndex = view.getUint32(4, true);
  const fieldA = view.getUint32(8, true);
  const fieldB = view.getUint32(12, true);
  const fieldC = view.getUint32(16, true);
  const pts = view.getFloat64(20, true);
  const payload = bytes.subarray(MEDIA_HEADER_SIZE);
  const payloadLength = payload.byteLength;

  if (type === MEDIA_MESSAGE_TYPE.video) {
    const width = fieldA;
    const height = fieldB;
    const strideBytes = fieldC;
    if (
      !isPositiveInteger(width) ||
      !isPositiveInteger(height) ||
      !isPositiveInteger(strideBytes) ||
      strideBytes < width * 4 ||
      !Number.isSafeInteger(strideBytes * height) ||
      strideBytes * height !== payloadLength
    ) {
      return null;
    }

    return { type: 'video', frameIndex, pts, width, height, strideBytes, payload };
  }

  if (type === MEDIA_MESSAGE_TYPE.audio) {
    const sampleRate = fieldA;
    const channels = fieldB;
    const sampleFrames = fieldC;
    if (
      !isPositiveInteger(sampleRate) ||
      !isPositiveInteger(channels) ||
      !isPositiveInteger(sampleFrames) ||
      !Number.isSafeInteger(sampleFrames * channels * 2) ||
      sampleFrames * channels * 2 !== payloadLength
    ) {
      return null;
    }

    return { type: 'audio', frameIndex, pts, sampleRate, channels, sampleFrames, payload };
  }

  return null;
}
