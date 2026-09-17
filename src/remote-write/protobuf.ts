/**
 * Minimal hand-rolled encoder for the Prometheus remote_write v1 wire
 * format (the `prompb` `WriteRequest` message), matching this repo's
 * no-heavy-dependency convention (no protobufjs) — the schema needed here is
 * small enough to encode directly:
 *
 *   WriteRequest { repeated TimeSeries timeseries = 1; }
 *   TimeSeries   { repeated Label labels = 1; repeated Sample samples = 2; }
 *   Label        { string name = 1; string value = 2; }
 *   Sample       { double value = 1; int64 timestamp = 2; }   // ms since epoch
 *
 * All field numbers here are <=3, so every tag is a single byte
 * (`tag = (fieldNumber << 3) | wireType`). Wire types used: varint (0) for
 * `timestamp`, 64-bit (1) for `value`, length-delimited (2) for strings and
 * every repeated embedded message. `int64` is a plain varint, not zigzag
 * (zigzag is only for `sintN`); timestamps here are always non-negative and
 * far below 2^53, so a plain JS `number` is safe and no `BigInt` is needed.
 */

export interface RwLabel {
  name: string;
  value: string;
}

export interface RwSample {
  value: number;
  timestampMs: number;
}

export interface RwTimeSeries {
  labels: RwLabel[];
  samples: RwSample[];
}

function varint(n: number): Buffer {
  const bytes: number[] = [];
  let v = n;
  while (v >= 0x80) {
    bytes.push((v & 0x7f) | 0x80);
    // Division rather than `>>> 7`, which would truncate to 32 bits.
    v = Math.floor(v / 128);
  }
  bytes.push(v);
  return Buffer.from(bytes);
}

function tag(fieldNumber: number, wireType: number): Buffer {
  return varint((fieldNumber << 3) | wireType);
}

function lengthDelimited(fieldNumber: number, payload: Buffer): Buffer {
  return Buffer.concat([tag(fieldNumber, 2), varint(payload.length), payload]);
}

function stringField(fieldNumber: number, value: string): Buffer {
  return lengthDelimited(fieldNumber, Buffer.from(value, 'utf8'));
}

function doubleField(fieldNumber: number, value: number): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeDoubleLE(value, 0);
  return Buffer.concat([tag(fieldNumber, 1), buf]);
}

function varintField(fieldNumber: number, value: number): Buffer {
  return Buffer.concat([tag(fieldNumber, 0), varint(value)]);
}

function encodeLabel(label: RwLabel): Buffer {
  return Buffer.concat([stringField(1, label.name), stringField(2, label.value)]);
}

function encodeSample(sample: RwSample): Buffer {
  return Buffer.concat([doubleField(1, sample.value), varintField(2, sample.timestampMs)]);
}

function encodeTimeSeries(series: RwTimeSeries): Buffer {
  // Prometheus's own remote-write receiver rejects out-of-order labels, and
  // compliant remote_write receivers generally expect it too. `_` (0x5F)
  // sorts before any lowercase letter (0x61+), so a plain ascending sort on
  // label name naturally puts `__name__` first without special-casing it.
  const sorted = [...series.labels].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const parts = [
    ...sorted.map((label) => lengthDelimited(1, encodeLabel(label))),
    ...series.samples.map((sample) => lengthDelimited(2, encodeSample(sample))),
  ];
  return Buffer.concat(parts);
}

export function encodeWriteRequest(series: RwTimeSeries[]): Buffer {
  return Buffer.concat(series.map((ts) => lengthDelimited(1, encodeTimeSeries(ts))));
}
