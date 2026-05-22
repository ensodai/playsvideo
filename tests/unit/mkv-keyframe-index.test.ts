import { Blob } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { StreamSource } from 'mediabunny';
import {
  buildMkvKeyframeIndexFromBlob,
  buildMkvKeyframeIndexFromSource,
  parseMkvCues,
} from '../../src/pipeline/mkv-keyframe-index.js';

const EBML_ID = 0x1a45dfa3;
const VOID_ID = 0xec;
const SEGMENT_ID = 0x18538067;
const SEEKHEAD_ID = 0x114d9b74;
const SEEK_ID = 0x4dbb;
const SEEKID_ID = 0x53ab;
const SEEKPOSITION_ID = 0x53ac;
const INFO_ID = 0x1549a966;
const TIMESTAMP_SCALE_ID = 0x2ad7b1;
const DURATION_ID = 0x4489;
const TRACKS_ID = 0x1654ae6b;
const TRACK_ENTRY_ID = 0xae;
const TRACK_NUMBER_ID = 0xd7;
const TRACK_TYPE_ID = 0x83;
const FLAG_ENABLED_ID = 0xb9;
const FLAG_DEFAULT_ID = 0x88;
const CUES_ID = 0x1c53bb6b;
const CUEPOINT_ID = 0xbb;
const CUETIME_ID = 0xb3;
const CUETRACKPOSITIONS_ID = 0xb7;
const CUETRACK_ID = 0xf7;
const CUECLUSTERPOSITION_ID = 0xf1;
const CLUSTER_ID = 0x1f43b675;

function writeElementId(id: number): Uint8Array {
  if (id < 0x100) return new Uint8Array([id]);
  if (id < 0x10000) return new Uint8Array([(id >> 8) & 0xff, id & 0xff]);
  if (id < 0x1000000) return new Uint8Array([(id >> 16) & 0xff, (id >> 8) & 0xff, id & 0xff]);
  return new Uint8Array([(id >> 24) & 0xff, (id >> 16) & 0xff, (id >> 8) & 0xff, id & 0xff]);
}

function writeVarIntSize(size: number): Uint8Array {
  if (size < 0x7f) return new Uint8Array([0x80 | size]);
  if (size < 0x3fff) return new Uint8Array([0x40 | (size >> 8), size & 0xff]);
  if (size < 0x1fffff)
    return new Uint8Array([0x20 | (size >> 16), (size >> 8) & 0xff, size & 0xff]);
  return new Uint8Array([
    0x10 | (size >> 24),
    (size >> 16) & 0xff,
    (size >> 8) & 0xff,
    size & 0xff,
  ]);
}

function writeUint(value: number, width: number): Uint8Array {
  const buf = new Uint8Array(width);
  for (let i = width - 1; i >= 0; i--) {
    buf[i] = value & 0xff;
    value = Math.floor(value / 256);
  }
  return buf;
}

function ebmlElement(id: number, data: Uint8Array): Uint8Array {
  const idBytes = writeElementId(id);
  const sizeBytes = writeVarIntSize(data.length);
  const result = new Uint8Array(idBytes.length + sizeBytes.length + data.length);
  result.set(idBytes, 0);
  result.set(sizeBytes, idBytes.length);
  result.set(data, idBytes.length + sizeBytes.length);
  return result;
}

function ebmlUnknownSizeElement(id: number, data: Uint8Array): Uint8Array {
  const idBytes = writeElementId(id);
  const result = new Uint8Array(idBytes.length + 1 + data.length);
  result.set(idBytes, 0);
  result[idBytes.length] = 0xff;
  result.set(data, idBytes.length + 1);
  return result;
}

function ebmlUintElement(id: number, value: number, width?: number): Uint8Array {
  const w = width ?? (value < 0x100 ? 1 : value < 0x10000 ? 2 : value < 0x1000000 ? 3 : 4);
  return ebmlElement(id, writeUint(value, w));
}

function ebmlFloat64Element(id: number, value: number): Uint8Array {
  const buf = new Uint8Array(8);
  const view = new DataView(buf.buffer);
  view.setFloat64(0, value, false);
  return ebmlElement(id, buf);
}

function concat(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((sum, array) => sum + array.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const array of arrays) {
    result.set(array, offset);
    offset += array.length;
  }
  return result;
}

interface BuildMkvBufferOptions {
  segmentPaddingBytes?: number;
  topLevelPaddingBytes?: number;
  clusterBeforeCuesBytes?: number;
  unknownSizeCues?: boolean;
}

function buildMkvBuffer(
  cues: Array<{ cueTime: number; track: number; clusterOffset: number }>,
  timestampScale = 1_000_000,
  tracks: Array<{ number: number; type: number; enabled?: boolean; default?: boolean }> = [
    { number: 1, type: 1 },
  ],
  options: BuildMkvBufferOptions = {},
): Uint8Array {
  const docType = new TextEncoder().encode('matroska');
  const ebmlHeader = ebmlElement(
    EBML_ID,
    concat(ebmlUintElement(0x4286, 1), ebmlUintElement(0x42f7, 1), ebmlElement(0x4282, docType)),
  );

  const durationTicks = (cues[cues.length - 1]?.cueTime ?? 0) + 1000;
  const infoElement = ebmlElement(
    INFO_ID,
    concat(
      ebmlUintElement(TIMESTAMP_SCALE_ID, timestampScale, 4),
      ebmlFloat64Element(DURATION_ID, durationTicks),
    ),
  );
  const tracksElement = tracks
    ? ebmlElement(
        TRACKS_ID,
        concat(
          ...tracks.map((track) =>
            ebmlElement(
              TRACK_ENTRY_ID,
              concat(
                ebmlUintElement(TRACK_NUMBER_ID, track.number),
                ebmlUintElement(TRACK_TYPE_ID, track.type),
                track.enabled === undefined
                  ? new Uint8Array()
                  : ebmlUintElement(FLAG_ENABLED_ID, Number(track.enabled)),
                track.default === undefined
                  ? new Uint8Array()
                  : ebmlUintElement(FLAG_DEFAULT_ID, Number(track.default)),
              ),
            ),
          ),
        ),
      )
    : new Uint8Array();

  const cuePointElements = cues.map((cue) =>
    ebmlElement(
      CUEPOINT_ID,
      concat(
        ebmlUintElement(CUETIME_ID, cue.cueTime),
        ebmlElement(
          CUETRACKPOSITIONS_ID,
          concat(
            ebmlUintElement(CUETRACK_ID, cue.track),
            ebmlUintElement(CUECLUSTERPOSITION_ID, cue.clusterOffset, 4),
          ),
        ),
      ),
    ),
  );
  const cuesPayload = concat(...cuePointElements);
  const cuesElement = options.unknownSizeCues
    ? ebmlUnknownSizeElement(CUES_ID, cuesPayload)
    : ebmlElement(CUES_ID, cuesPayload);

  const segmentPadding = options.segmentPaddingBytes
    ? ebmlElement(VOID_ID, new Uint8Array(options.segmentPaddingBytes))
    : new Uint8Array();
  const topLevelPadding = options.topLevelPaddingBytes
    ? ebmlElement(VOID_ID, new Uint8Array(options.topLevelPaddingBytes))
    : new Uint8Array();
  const clusterBeforeCues = options.clusterBeforeCuesBytes
    ? ebmlElement(CLUSTER_ID, new Uint8Array(options.clusterBeforeCuesBytes))
    : new Uint8Array();

  function buildSeekHead(infoPos: number, tracksPos: number, cuesPos: number): Uint8Array {
    const seekInfo = ebmlElement(
      SEEK_ID,
      concat(
        ebmlElement(SEEKID_ID, writeElementId(INFO_ID)),
        ebmlUintElement(SEEKPOSITION_ID, infoPos, 4),
      ),
    );
    const seekTracks = ebmlElement(
      SEEK_ID,
      concat(
        ebmlElement(SEEKID_ID, writeElementId(TRACKS_ID)),
        ebmlUintElement(SEEKPOSITION_ID, tracksPos, 4),
      ),
    );
    const seekCues = ebmlElement(
      SEEK_ID,
      concat(
        ebmlElement(SEEKID_ID, writeElementId(CUES_ID)),
        ebmlUintElement(SEEKPOSITION_ID, cuesPos, 4),
      ),
    );
    return ebmlElement(SEEKHEAD_ID, concat(seekInfo, seekTracks, seekCues));
  }

  const seekHeadEstimate = buildSeekHead(0, 0, 0);
  const infoRelOffset = segmentPadding.length + seekHeadEstimate.length;
  const tracksRelOffset = infoRelOffset + infoElement.length;
  const cuesRelOffset = tracksRelOffset + tracksElement.length + clusterBeforeCues.length;
  const seekHead = buildSeekHead(infoRelOffset, tracksRelOffset, cuesRelOffset);

  return concat(
    ebmlHeader,
    topLevelPadding,
    ebmlElement(
      SEGMENT_ID,
      concat(segmentPadding, seekHead, infoElement, tracksElement, clusterBeforeCues, cuesElement),
    ),
  );
}

function bufferRead(buffer: Uint8Array) {
  return (start: number, end: number) => buffer.subarray(start, end);
}

function trackingRead(buffer: Uint8Array) {
  const reads: Array<{ start: number; end: number }> = [];
  return {
    read: (start: number, end: number) => {
      reads.push({ start, end });
      return buffer.subarray(start, end);
    },
    reads,
    totalBytesRead: () => reads.reduce((sum, read) => sum + read.end - read.start, 0),
  };
}

describe('mkv-keyframe-index', () => {
  it('parses synthetic MKV cues', async () => {
    const mkv = buildMkvBuffer([
      { cueTime: 0, track: 1, clusterOffset: 1000 },
      { cueTime: 1000, track: 1, clusterOffset: 50_000 },
      { cueTime: 2000, track: 1, clusterOffset: 100_000 },
    ]);

    const cues = await parseMkvCues(bufferRead(mkv), mkv.length);

    expect(cues).toHaveLength(3);
    expect(cues.map((cue) => cue.timestampMs)).toEqual([0, 1000, 2000]);
  });

  it('builds a keyframe index from a Blob', async () => {
    const mkv = buildMkvBuffer([
      { cueTime: 0, track: 1, clusterOffset: 1000 },
      { cueTime: 1000, track: 1, clusterOffset: 50_000 },
      { cueTime: 2000, track: 1, clusterOffset: 100_000 },
    ]);

    const index = await buildMkvKeyframeIndexFromBlob(new Blob([mkv]));

    expect(index).toEqual({
      duration: 3,
      keyframes: [
        { timestamp: 0, sequenceNumber: 0 },
        { timestamp: 1, sequenceNumber: 1 },
        { timestamp: 2, sequenceNumber: 2 },
      ],
    });
  });

  it('filters cue points to the video track when track metadata is available', async () => {
    const mkv = buildMkvBuffer(
      [
        { cueTime: 0, track: 1, clusterOffset: 1000 },
        { cueTime: 500, track: 2, clusterOffset: 20_000 },
        { cueTime: 1000, track: 2, clusterOffset: 50_000 },
        { cueTime: 2000, track: 1, clusterOffset: 100_000 },
      ],
      1_000_000,
      [
        { number: 1, type: 1 },
        { number: 2, type: 2 },
      ],
    );

    const cues = await parseMkvCues(bufferRead(mkv), mkv.length);

    expect(cues.map((cue) => cue.timestampMs)).toEqual([0, 2000]);
  });

  it('does not trust cues when no video track can be identified', async () => {
    const mkv = buildMkvBuffer(
      [
        { cueTime: 0, track: 2, clusterOffset: 1000 },
        { cueTime: 1000, track: 2, clusterOffset: 50_000 },
      ],
      1_000_000,
      [{ number: 2, type: 2 }],
    );

    const cues = await parseMkvCues(bufferRead(mkv), mkv.length);

    expect(cues).toEqual([]);
  });

  it('uses the default video track when multiple video tracks are present', async () => {
    const mkv = buildMkvBuffer(
      [
        { cueTime: 0, track: 1, clusterOffset: 1000 },
        { cueTime: 1000, track: 2, clusterOffset: 50_000 },
        { cueTime: 2000, track: 1, clusterOffset: 100_000 },
        { cueTime: 3000, track: 2, clusterOffset: 150_000 },
      ],
      1_000_000,
      [
        { number: 1, type: 1, default: false },
        { number: 2, type: 1, default: true },
      ],
    );

    const cues = await parseMkvCues(bufferRead(mkv), mkv.length);

    expect(cues.map((cue) => cue.timestampMs)).toEqual([1000, 3000]);
  });

  it('skips disabled video tracks when matching cues', async () => {
    const mkv = buildMkvBuffer(
      [
        { cueTime: 0, track: 1, clusterOffset: 1000 },
        { cueTime: 1000, track: 2, clusterOffset: 50_000 },
      ],
      1_000_000,
      [
        { number: 1, type: 1, enabled: false },
        { number: 2, type: 1 },
      ],
    );

    const cues = await parseMkvCues(bufferRead(mkv), mkv.length);

    expect(cues.map((cue) => cue.timestampMs)).toEqual([1000]);
  });

  it('scans sparse segment metadata past large front padding', async () => {
    const mkv = buildMkvBuffer(
      [
        { cueTime: 0, track: 1, clusterOffset: 1000 },
        { cueTime: 1000, track: 1, clusterOffset: 50_000 },
      ],
      1_000_000,
      [{ number: 1, type: 1 }],
      { segmentPaddingBytes: 8192 },
    );

    const cues = await parseMkvCues(bufferRead(mkv), mkv.length);

    expect(cues.map((cue) => cue.timestampMs)).toEqual([0, 1000]);
  });

  it('skips top-level padding before the Segment element', async () => {
    const mkv = buildMkvBuffer(
      [
        { cueTime: 0, track: 1, clusterOffset: 1000 },
        { cueTime: 1000, track: 1, clusterOffset: 50_000 },
      ],
      1_000_000,
      [{ number: 1, type: 1 }],
      { topLevelPaddingBytes: 4096 },
    );

    const cues = await parseMkvCues(bufferRead(mkv), mkv.length);

    expect(cues.map((cue) => cue.timestampMs)).toEqual([0, 1000]);
  });

  it('uses SeekHead offsets without reading cluster payloads', async () => {
    const mkv = buildMkvBuffer(
      [
        { cueTime: 0, track: 1, clusterOffset: 1000 },
        { cueTime: 1000, track: 1, clusterOffset: 50_000 },
      ],
      1_000_000,
      [{ number: 1, type: 1 }],
      { clusterBeforeCuesBytes: 20_000 },
    );
    const { read, totalBytesRead } = trackingRead(mkv);

    const cues = await parseMkvCues(read, mkv.length);

    expect(cues.map((cue) => cue.timestampMs)).toEqual([0, 1000]);
    expect(totalBytesRead()).toBeLessThan(2000);
  });

  it('does not read the rest of the file when Cues has unknown size', async () => {
    const mkv = buildMkvBuffer(
      [
        { cueTime: 0, track: 1, clusterOffset: 1000 },
        { cueTime: 1000, track: 1, clusterOffset: 50_000 },
      ],
      1_000_000,
      [{ number: 1, type: 1 }],
      { unknownSizeCues: true, clusterBeforeCuesBytes: 20_000 },
    );
    const { read, totalBytesRead } = trackingRead(mkv);

    const cues = await parseMkvCues(read, mkv.length);

    expect(cues).toEqual([]);
    expect(totalBytesRead()).toBeLessThan(2000);
  });

  it('builds a keyframe index from a StreamSource', async () => {
    const mkv = buildMkvBuffer([
      { cueTime: 0, track: 1, clusterOffset: 1000 },
      { cueTime: 1000, track: 1, clusterOffset: 50_000 },
    ]);

    const source = new StreamSource({
      getSize: () => mkv.length,
      read: (start, end) => mkv.subarray(start, end),
    });

    const index = await buildMkvKeyframeIndexFromSource(source);

    expect(index?.duration).toBe(2);
    expect(index?.keyframes.map((entry) => entry.timestamp)).toEqual([0, 1]);
  });

  it('returns null when no cues are present', async () => {
    const docType = new TextEncoder().encode('matroska');
    const mkv = concat(
      ebmlElement(
        EBML_ID,
        concat(
          ebmlUintElement(0x4286, 1),
          ebmlUintElement(0x42f7, 1),
          ebmlElement(0x4282, docType),
        ),
      ),
      ebmlElement(
        SEGMENT_ID,
        ebmlElement(
          INFO_ID,
          concat(
            ebmlUintElement(TIMESTAMP_SCALE_ID, 1_000_000, 4),
            ebmlFloat64Element(DURATION_ID, 1000),
          ),
        ),
      ),
    );

    const index = await buildMkvKeyframeIndexFromBlob(new Blob([mkv]));
    expect(index).toBeNull();
  });
});
