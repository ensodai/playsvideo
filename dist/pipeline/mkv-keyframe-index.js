export async function buildMkvKeyframeIndexFromSource(source) {
    const size = await source.getSizeOrNull();
    if (size === null) {
        return null;
    }
    return buildMkvKeyframeIndex(async (start, end) => {
        const result = await source._read(start, end);
        if (!result) {
            throw new Error(`MKV cue read failed for source range ${start}-${end}`);
        }
        const sliceStart = start - result.offset;
        const sliceEnd = end - result.offset;
        if (sliceStart < 0 || sliceEnd > result.bytes.length || sliceStart > sliceEnd) {
            throw new Error(`MKV cue read returned mismatched range ${result.offset}-${result.offset + result.bytes.length}`);
        }
        return result.bytes.subarray(sliceStart, sliceEnd);
    }, size);
}
export async function buildMkvKeyframeIndexFromBlob(blob) {
    return buildMkvKeyframeIndex(async (start, end) => new Uint8Array(await blob.slice(start, end).arrayBuffer()), blob.size);
}
export async function buildMkvKeyframeIndexFromUrl(url) {
    try {
        const size = await getUrlSize(url);
        return buildMkvKeyframeIndex(async (start, end) => {
            const response = await fetch(url, {
                headers: {
                    Range: `bytes=${start}-${end - 1}`,
                },
            });
            if (response.status !== 206) {
                throw new Error(`MKV cue range request failed: HTTP ${response.status}`);
            }
            return new Uint8Array(await response.arrayBuffer());
        }, size);
    }
    catch {
        return null;
    }
}
async function getUrlSize(url) {
    const response = await fetch(url, { method: 'HEAD' });
    if (!response.ok) {
        throw new Error(`MKV cue HEAD failed: HTTP ${response.status}`);
    }
    const contentLength = response.headers.get('content-length');
    const size = contentLength ? Number(contentLength) : NaN;
    if (!Number.isFinite(size) || size <= 0) {
        throw new Error('MKV cue HEAD missing content-length');
    }
    return size;
}
async function buildMkvKeyframeIndex(read, fileSize) {
    try {
        const parsed = await parseMkvCueIndex(read, fileSize);
        if (!parsed.durationSec || !Number.isFinite(parsed.durationSec) || parsed.durationSec <= 0) {
            return null;
        }
        if (parsed.cuePoints.length === 0) {
            return null;
        }
        return {
            duration: parsed.durationSec,
            keyframes: parsed.cuePoints.map((cue, sequenceNumber) => ({
                timestamp: cue.timestampMs / 1000,
                sequenceNumber,
            })),
        };
    }
    catch {
        return null;
    }
}
export async function parseMkvCues(read, fileSize) {
    const parsed = await parseMkvCueIndex(read, fileSize);
    return parsed.cuePoints;
}
export async function parseMkvCueIndex(read, fileSize) {
    const headerData = await read(0, Math.min(64, fileSize));
    const headerEl = readElementHeader(headerData, 0);
    if (!headerEl || headerEl.id !== EBML_ID) {
        throw new Error('Not an EBML file');
    }
    const segment = await findSegmentElement(read, fileSize, headerEl.dataStart + headerEl.dataSize);
    const segmentDataStart = segment.offset + segment.element.dataStart;
    let timestampScale = 1_000_000;
    const segmentEnd = segment.element.dataSize === UNKNOWN_SIZE
        ? fileSize
        : segmentDataStart + segment.element.dataSize;
    const { cuesOffset, infoOffset, tracksOffset } = await scanSegmentMetadata(read, segmentDataStart, Math.min(segmentEnd, fileSize), fileSize);
    let durationSec = null;
    if (infoOffset !== undefined) {
        const infoHdrBuf = await read(infoOffset, Math.min(infoOffset + 64, fileSize));
        const infoEl = readElementHeader(infoHdrBuf, 0);
        if (infoEl && infoEl.id === INFO_ID && infoEl.dataSize !== UNKNOWN_SIZE) {
            const infoEnd = infoEl.dataStart + infoEl.dataSize;
            const infoBuf = infoEnd <= infoHdrBuf.length
                ? infoHdrBuf
                : await read(infoOffset, Math.min(infoOffset + infoEnd, fileSize));
            let ip = infoEl.dataStart;
            while (ip < infoEnd && ip < infoBuf.length - 2) {
                const child = readElementHeader(infoBuf, ip);
                if (!child)
                    break;
                if (child.id === TIMESTAMP_SCALE_ID) {
                    timestampScale = readUint(infoBuf, ip + child.dataStart, child.dataSize);
                }
                else if (child.id === DURATION_ID) {
                    const durationTicks = readFloat(infoBuf, ip + child.dataStart, child.dataSize);
                    if (durationTicks !== null && Number.isFinite(durationTicks) && durationTicks > 0) {
                        durationSec = (durationTicks * timestampScale) / 1_000_000_000;
                    }
                }
                if (child.dataSize === UNKNOWN_SIZE)
                    break;
                ip += child.dataStart + child.dataSize;
            }
        }
    }
    const videoTrackNumber = tracksOffset !== undefined ? await readVideoTrackNumber(read, tracksOffset, fileSize) : null;
    if (videoTrackNumber === null) {
        return { cuePoints: [], durationSec };
    }
    if (cuesOffset === undefined) {
        return { cuePoints: [], durationSec };
    }
    const cuesHdrBuf = await read(cuesOffset, Math.min(cuesOffset + 16, fileSize));
    const cuesEl = readElementHeader(cuesHdrBuf, 0);
    if (!cuesEl || cuesEl.id !== CUES_ID) {
        return { cuePoints: [], durationSec };
    }
    if (cuesEl.dataSize === UNKNOWN_SIZE) {
        return { cuePoints: [], durationSec };
    }
    const cuesDataStart = cuesOffset + cuesEl.dataStart;
    const cuesDataEnd = cuesDataStart + cuesEl.dataSize;
    if (cuesDataEnd > fileSize) {
        return { cuePoints: [], durationSec };
    }
    const cuesBuf = await read(cuesDataStart, cuesDataEnd);
    const cuePoints = [];
    let cp = 0;
    while (cp < cuesBuf.length - 2) {
        const cpEl = readElementHeader(cuesBuf, cp);
        if (!cpEl)
            break;
        if (cpEl.id === CUEPOINT_ID) {
            let cueTime;
            let hasAnyClusterPosition = false;
            let hasMatchingTrackPosition = false;
            const cpEnd = cp + cpEl.dataStart + cpEl.dataSize;
            let inner = cp + cpEl.dataStart;
            while (inner < cpEnd && inner < cuesBuf.length - 2) {
                const child = readElementHeader(cuesBuf, inner);
                if (!child)
                    break;
                if (child.id === CUETIME_ID) {
                    cueTime = readUint(cuesBuf, inner + child.dataStart, child.dataSize);
                }
                else if (child.id === CUETRACKPOSITIONS_ID) {
                    const ctpEnd = inner + child.dataStart + child.dataSize;
                    let ctpInner = inner + child.dataStart;
                    let cueTrack;
                    let clusterPosition;
                    while (ctpInner < ctpEnd && ctpInner < cuesBuf.length - 2) {
                        const ctpChild = readElementHeader(cuesBuf, ctpInner);
                        if (!ctpChild)
                            break;
                        if (ctpChild.id === CUETRACK_ID) {
                            cueTrack = readUint(cuesBuf, ctpInner + ctpChild.dataStart, ctpChild.dataSize);
                        }
                        else if (ctpChild.id === CUECLUSTERPOSITION_ID) {
                            clusterPosition = readUint(cuesBuf, ctpInner + ctpChild.dataStart, ctpChild.dataSize);
                        }
                        if (ctpChild.dataSize === UNKNOWN_SIZE)
                            break;
                        ctpInner += ctpChild.dataStart + ctpChild.dataSize;
                    }
                    if (clusterPosition !== undefined) {
                        hasAnyClusterPosition = true;
                        if (videoTrackNumber !== null && cueTrack === videoTrackNumber) {
                            hasMatchingTrackPosition = true;
                        }
                    }
                }
                if (child.dataSize === UNKNOWN_SIZE)
                    break;
                inner += child.dataStart + child.dataSize;
            }
            if (cueTime !== undefined && hasAnyClusterPosition && hasMatchingTrackPosition) {
                cuePoints.push({
                    timestampMs: (cueTime * timestampScale) / 1_000_000,
                });
            }
        }
        if (cpEl.dataSize === UNKNOWN_SIZE)
            break;
        cp += cpEl.dataStart + cpEl.dataSize;
    }
    return { cuePoints: dedupeCuePoints(cuePoints), durationSec };
}
async function findSegmentElement(read, fileSize, startOffset) {
    let offset = startOffset;
    for (let i = 0; offset < fileSize && i < MAX_ELEMENTS_BEFORE_SEGMENT; i++) {
        const element = await readElementHeaderAt(read, fileSize, offset);
        if (!element)
            break;
        if (element.id === SEGMENT_ID) {
            return { offset, element };
        }
        const nextOffset = elementEndOffset(offset, element);
        if (nextOffset === null || nextOffset <= offset)
            break;
        offset = nextOffset;
    }
    throw new Error('Segment element not found');
}
async function scanSegmentMetadata(read, segmentDataStart, segmentEnd, fileSize) {
    const offsets = {};
    let offset = segmentDataStart;
    for (let i = 0; offset < segmentEnd && i < MAX_SEGMENT_METADATA_ELEMENTS; i++) {
        const element = await readElementHeaderAt(read, fileSize, offset);
        if (!element)
            break;
        if (element.id === CLUSTER_ID) {
            break;
        }
        if (element.id === SEEKHEAD_ID) {
            mergeMetadataOffsets(offsets, await readSeekHeadOffsets(read, offset, element, segmentDataStart, fileSize));
        }
        else if (element.id === INFO_ID) {
            offsets.infoOffset ??= offset;
        }
        else if (element.id === TRACKS_ID) {
            offsets.tracksOffset ??= offset;
        }
        else if (element.id === CUES_ID) {
            offsets.cuesOffset ??= offset;
        }
        const nextOffset = elementEndOffset(offset, element);
        if (nextOffset === null || nextOffset <= offset)
            break;
        offset = nextOffset;
    }
    return offsets;
}
async function readSeekHeadOffsets(read, seekHeadOffset, seekHead, segmentDataStart, fileSize) {
    const offsets = {};
    if (seekHead.dataSize === UNKNOWN_SIZE || seekHead.dataSize > MAX_SEEKHEAD_BYTES) {
        return offsets;
    }
    const seekHeadDataStart = seekHeadOffset + seekHead.dataStart;
    const seekHeadDataEnd = seekHeadDataStart + seekHead.dataSize;
    if (seekHeadDataEnd > fileSize) {
        return offsets;
    }
    const seekBuf = await read(seekHeadDataStart, seekHeadDataEnd);
    let pos = 0;
    while (pos < seekBuf.length - 2) {
        const seekEl = readElementHeader(seekBuf, pos);
        if (!seekEl)
            break;
        if (seekEl.id === SEEK_ID) {
            const seekEnd = pos + seekEl.dataStart + seekEl.dataSize;
            let seekInner = pos + seekEl.dataStart;
            let seekId;
            let seekPosition;
            while (seekInner < seekEnd && seekInner < seekBuf.length - 2) {
                const innerEl = readElementHeader(seekBuf, seekInner);
                if (!innerEl)
                    break;
                if (innerEl.id === SEEKID_ID) {
                    seekId = readUint(seekBuf, seekInner + innerEl.dataStart, innerEl.dataSize);
                }
                else if (innerEl.id === SEEKPOSITION_ID) {
                    seekPosition = readUint(seekBuf, seekInner + innerEl.dataStart, innerEl.dataSize);
                }
                const nextInner = elementEndOffset(seekInner, innerEl);
                if (nextInner === null || nextInner <= seekInner)
                    break;
                seekInner = nextInner;
            }
            if (seekId !== undefined && seekPosition !== undefined) {
                const absoluteOffset = segmentDataStart + seekPosition;
                if (seekId === CUES_ID) {
                    offsets.cuesOffset ??= absoluteOffset;
                }
                else if (seekId === INFO_ID) {
                    offsets.infoOffset ??= absoluteOffset;
                }
                else if (seekId === TRACKS_ID) {
                    offsets.tracksOffset ??= absoluteOffset;
                }
            }
        }
        const nextPos = elementEndOffset(pos, seekEl);
        if (nextPos === null || nextPos <= pos)
            break;
        pos = nextPos;
    }
    return offsets;
}
function mergeMetadataOffsets(target, source) {
    target.cuesOffset ??= source.cuesOffset;
    target.infoOffset ??= source.infoOffset;
    target.tracksOffset ??= source.tracksOffset;
}
async function readElementHeaderAt(read, fileSize, offset) {
    if (offset < 0 || offset >= fileSize) {
        return null;
    }
    const headerBuf = await read(offset, Math.min(offset + MAX_ELEMENT_HEADER_BYTES, fileSize));
    return readElementHeader(headerBuf, 0);
}
function elementEndOffset(offset, element) {
    if (element.dataSize === UNKNOWN_SIZE) {
        return null;
    }
    return offset + element.dataStart + element.dataSize;
}
function dedupeCuePoints(cuePoints) {
    const sorted = [...cuePoints].sort((a, b) => a.timestampMs - b.timestampMs);
    const deduped = [];
    for (const cue of sorted) {
        if (deduped.length === 0 || cue.timestampMs !== deduped[deduped.length - 1].timestampMs) {
            deduped.push(cue);
        }
    }
    return deduped;
}
async function readVideoTrackNumber(read, tracksOffset, fileSize) {
    const tracksHdrBuf = await read(tracksOffset, Math.min(tracksOffset + 16, fileSize));
    const tracksEl = readElementHeader(tracksHdrBuf, 0);
    if (!tracksEl || tracksEl.id !== TRACKS_ID || tracksEl.dataSize === UNKNOWN_SIZE) {
        return null;
    }
    const tracksEnd = tracksEl.dataStart + tracksEl.dataSize;
    const tracksBuf = tracksEnd <= tracksHdrBuf.length
        ? tracksHdrBuf
        : await read(tracksOffset, Math.min(tracksOffset + tracksEnd, fileSize));
    let firstVideoTrackNumber = null;
    let defaultVideoTrackNumber = null;
    let pos = tracksEl.dataStart;
    while (pos < tracksEnd && pos < tracksBuf.length - 2) {
        const trackEntry = readElementHeader(tracksBuf, pos);
        if (!trackEntry)
            break;
        if (trackEntry.id === TRACK_ENTRY_ID) {
            const entryEnd = pos + trackEntry.dataStart + trackEntry.dataSize;
            let entryPos = pos + trackEntry.dataStart;
            let trackNumber;
            let trackType;
            let enabled = true;
            let isDefault = true;
            while (entryPos < entryEnd && entryPos < tracksBuf.length - 2) {
                const child = readElementHeader(tracksBuf, entryPos);
                if (!child)
                    break;
                if (child.id === TRACK_NUMBER_ID) {
                    trackNumber = readUint(tracksBuf, entryPos + child.dataStart, child.dataSize);
                }
                else if (child.id === TRACK_TYPE_ID) {
                    trackType = readUint(tracksBuf, entryPos + child.dataStart, child.dataSize);
                }
                else if (child.id === FLAG_ENABLED_ID) {
                    enabled = readUint(tracksBuf, entryPos + child.dataStart, child.dataSize) !== 0;
                }
                else if (child.id === FLAG_DEFAULT_ID) {
                    isDefault = readUint(tracksBuf, entryPos + child.dataStart, child.dataSize) !== 0;
                }
                if (child.dataSize === UNKNOWN_SIZE)
                    break;
                entryPos += child.dataStart + child.dataSize;
            }
            if (trackNumber !== undefined && trackType === VIDEO_TRACK_TYPE && enabled) {
                firstVideoTrackNumber ??= trackNumber;
                if (isDefault) {
                    defaultVideoTrackNumber ??= trackNumber;
                }
            }
        }
        if (trackEntry.dataSize === UNKNOWN_SIZE)
            break;
        pos += trackEntry.dataStart + trackEntry.dataSize;
    }
    return defaultVideoTrackNumber ?? firstVideoTrackNumber;
}
const EBML_ID = 0x1a45dfa3;
const SEGMENT_ID = 0x18538067;
const SEEKHEAD_ID = 0x114d9b74;
const SEEK_ID = 0x4dbb;
const SEEKID_ID = 0x53ab;
const SEEKPOSITION_ID = 0x53ac;
const INFO_ID = 0x1549a966;
const TIMESTAMP_SCALE_ID = 0x2ad7b1;
const DURATION_ID = 0x4489;
const CUES_ID = 0x1c53bb6b;
const CUEPOINT_ID = 0xbb;
const CUETIME_ID = 0xb3;
const CUETRACKPOSITIONS_ID = 0xb7;
const CUETRACK_ID = 0xf7;
const CUECLUSTERPOSITION_ID = 0xf1;
const TRACKS_ID = 0x1654ae6b;
const TRACK_ENTRY_ID = 0xae;
const TRACK_NUMBER_ID = 0xd7;
const TRACK_TYPE_ID = 0x83;
const FLAG_ENABLED_ID = 0xb9;
const FLAG_DEFAULT_ID = 0x88;
const CLUSTER_ID = 0x1f43b675;
const UNKNOWN_SIZE = -1;
const VIDEO_TRACK_TYPE = 1;
const MAX_ELEMENT_HEADER_BYTES = 16;
const MAX_ELEMENTS_BEFORE_SEGMENT = 64;
const MAX_SEGMENT_METADATA_ELEMENTS = 512;
const MAX_SEEKHEAD_BYTES = 1024 * 1024;
function readElementHeader(buf, offset) {
    if (offset >= buf.length)
        return null;
    const idResult = readVarIntRaw(buf, offset);
    if (!idResult)
        return null;
    const sizeResult = readVarIntValue(buf, offset + idResult.length);
    if (!sizeResult)
        return null;
    return {
        id: idResult.value,
        dataStart: idResult.length + sizeResult.length,
        dataSize: sizeResult.unknown ? UNKNOWN_SIZE : sizeResult.value,
    };
}
function readVarIntRaw(buf, offset) {
    if (offset >= buf.length)
        return null;
    const first = buf[offset];
    let mask = 0x80;
    let length = 1;
    while (length <= 4 && (first & mask) === 0) {
        mask >>= 1;
        length++;
    }
    if (length > 4 || offset + length > buf.length)
        return null;
    let value = 0;
    for (let i = 0; i < length; i++) {
        value = (value << 8) | buf[offset + i];
    }
    return { value, length };
}
function readVarIntValue(buf, offset) {
    if (offset >= buf.length)
        return null;
    const first = buf[offset];
    let mask = 0x80;
    let length = 1;
    while (length <= 8 && (first & mask) === 0) {
        mask >>= 1;
        length++;
    }
    if (length > 8 || offset + length > buf.length)
        return null;
    let value = first & (mask - 1);
    let allOnes = value === mask - 1;
    for (let i = 1; i < length; i++) {
        value = value * 256 + buf[offset + i];
        if (buf[offset + i] !== 0xff) {
            allOnes = false;
        }
    }
    return { value, length, unknown: allOnes };
}
function readUint(buf, offset, length) {
    let value = 0;
    for (let i = 0; i < length; i++) {
        value = value * 256 + buf[offset + i];
    }
    return value;
}
function readFloat(buf, offset, length) {
    const view = new DataView(buf.buffer, buf.byteOffset + offset, length);
    if (length === 4)
        return view.getFloat32(0, false);
    if (length === 8)
        return view.getFloat64(0, false);
    return null;
}
//# sourceMappingURL=mkv-keyframe-index.js.map