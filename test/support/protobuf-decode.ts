/**
 * Minimal test-only decoder for the remote_write `WriteRequest` wire format,
 * used to round-trip-verify `encodeWriteRequest`'s output without pulling in
 * protobufjs anywhere, including in tests.
 */
import type { RwLabel, RwSample, RwTimeSeries } from '../../src/remote-write/protobuf.js';

function readVarint(buf: Buffer, offset: number): [number, number] {
  let result = 0;
  let shift = 1;
  let pos = offset;
  for (;;) {
    const byte = buf[pos]!;
    pos += 1;
    result += (byte & 0x7f) * shift;
    if ((byte & 0x80) === 0) {
      break;
    }
    shift *= 128;
  }
  return [result, pos];
}

function readTag(buf: Buffer, offset: number): [{ fieldNumber: number; wireType: number }, number] {
  const [value, pos] = readVarint(buf, offset);
  return [{ fieldNumber: value >>> 3, wireType: value & 0x7 }, pos];
}

function readLengthDelimited(buf: Buffer, offset: number): [Buffer, number] {
  const [len, pos] = readVarint(buf, offset);
  return [buf.subarray(pos, pos + len), pos + len];
}

function decodeLabel(buf: Buffer): RwLabel {
  let offset = 0;
  let name = '';
  let value = '';
  while (offset < buf.length) {
    const [field, afterTag] = readTag(buf, offset);
    const [payload, afterPayload] = readLengthDelimited(buf, afterTag);
    if (field.fieldNumber === 1) name = payload.toString('utf8');
    else if (field.fieldNumber === 2) value = payload.toString('utf8');
    offset = afterPayload;
  }
  return { name, value };
}

function decodeSample(buf: Buffer): RwSample {
  let offset = 0;
  let value = 0;
  let timestampMs = 0;
  while (offset < buf.length) {
    const [field, afterTag] = readTag(buf, offset);
    if (field.wireType === 1) {
      value = buf.readDoubleLE(afterTag);
      offset = afterTag + 8;
    } else {
      const [v, afterVarint] = readVarint(buf, afterTag);
      timestampMs = v;
      offset = afterVarint;
    }
  }
  return { value, timestampMs };
}

function decodeTimeSeries(buf: Buffer): RwTimeSeries {
  let offset = 0;
  const labels: RwLabel[] = [];
  const samples: RwSample[] = [];
  while (offset < buf.length) {
    const [field, afterTag] = readTag(buf, offset);
    const [payload, afterPayload] = readLengthDelimited(buf, afterTag);
    if (field.fieldNumber === 1) labels.push(decodeLabel(payload));
    else if (field.fieldNumber === 2) samples.push(decodeSample(payload));
    offset = afterPayload;
  }
  return { labels, samples };
}

export function decodeWriteRequest(buf: Buffer): RwTimeSeries[] {
  let offset = 0;
  const series: RwTimeSeries[] = [];
  while (offset < buf.length) {
    const [field, afterTag] = readTag(buf, offset);
    const [payload, afterPayload] = readLengthDelimited(buf, afterTag);
    if (field.fieldNumber === 1) series.push(decodeTimeSeries(payload));
    offset = afterPayload;
  }
  return series;
}
