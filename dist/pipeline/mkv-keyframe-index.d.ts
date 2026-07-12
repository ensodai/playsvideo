import type { Source } from '../source.js';
import type { KeyframeIndex } from './types.js';
/**
 * Sparse Matroska cue reader.
 *
 * This exists because mediabunny's MKV key-packet iteration can seek into
 * clusters across the file even with metadataOnly enabled. The contract here is
 * stricter: read EBML headers plus Info, Tracks, SeekHead, and Cues metadata;
 * never read Cluster media payload while building the fast keyframe index.
 */
export interface MkvCuePoint {
    timestampMs: number;
}
export interface ParsedMkvCueIndex {
    cuePoints: MkvCuePoint[];
    durationSec: number | null;
}
export declare function buildMkvKeyframeIndexFromSource(source: Source): Promise<KeyframeIndex | null>;
export declare function buildMkvKeyframeIndexFromBlob(blob: Blob): Promise<KeyframeIndex | null>;
export declare function buildMkvKeyframeIndexFromUrl(url: string): Promise<KeyframeIndex | null>;
export declare function parseMkvCues(read: (start: number, end: number) => Uint8Array | Promise<Uint8Array>, fileSize: number): Promise<MkvCuePoint[]>;
export declare function parseMkvCueIndex(read: (start: number, end: number) => Uint8Array | Promise<Uint8Array>, fileSize: number): Promise<ParsedMkvCueIndex>;
//# sourceMappingURL=mkv-keyframe-index.d.ts.map