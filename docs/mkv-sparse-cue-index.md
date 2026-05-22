# MKV Sparse Cue Index

`playsvideo` has a small Matroska cue parser in
[`src/pipeline/mkv-keyframe-index.ts`](../src/pipeline/mkv-keyframe-index.ts)
for one specific reason: build an HLS segment boundary index from sparse
metadata reads.

Mediabunny is still the demuxer for actual packets. However, mediabunny's MKV
`metadataOnly` key-packet iteration may seek into clusters across the file to
verify or discover key packets. That is correct demuxer behavior, but it is too
expensive for the startup path when all we need is a keyframe timestamp list.

## Read Contract

The sparse parser may read:

- EBML and Segment element headers
- top-level Segment child headers before the first Cluster
- SeekHead
- Info
- Tracks
- Cues

The sparse parser must not read:

- Cluster media payloads
- full-file byte ranges
- packet data through mediabunny key-packet iteration

If required metadata cannot be found from front Segment metadata or SeekHead
offsets, the sparse parser should return `null`/empty results and let the
caller choose a fallback. It should not scan through media payloads to search
for Cues.

## Fail-Closed Cases

The parser intentionally refuses to build a cue index when:

- the video track number cannot be identified
- Cues has an unknown size
- Cues points outside the file
- Cues are not scoped to the selected video track

This avoids treating audio or subtitle cue points as video keyframes and avoids
accidentally reading the rest of the file for malformed metadata.

## Current Tradeoff

Matroska Cues are treated as video keyframe hints. Mediabunny's full path is
more authoritative because it can read clusters and inspect block key flags.
The sparse path deliberately does not do that. If a file has misleading video
Cues, the correct fix is a bounded sparse validation design, not a change that
reads Cluster payloads during index construction.
