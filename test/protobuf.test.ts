/**
 * Byte-level checks for the hand-rolled remote_write `WriteRequest` encoder,
 * plus a round-trip through a small test-only decoder (mirroring the
 * project's "avoid protobufjs" stance even here) to catch anything the
 * byte-level assertion alone wouldn't.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { encodeWriteRequest, type RwTimeSeries } from '../src/remote-write/protobuf.js';
import { decodeWriteRequest } from './support/protobuf-decode.js';

test('encodeWriteRequest produces the exact expected bytes for a single label/sample', () => {
  const encoded = encodeWriteRequest([
    {
      labels: [{ name: 'a', value: 'b' }],
      samples: [{ value: 1.5, timestampMs: 1000 }],
    },
  ]);

  // WriteRequest{ TimeSeries{ Label{name:"a",value:"b"}, Sample{value:1.5,timestamp:1000} } }
  const expected = Buffer.from([
    0x0a, 0x16, // field 1 (timeseries), length 22
    0x0a, 0x06, 0x0a, 0x01, 0x61, 0x12, 0x01, 0x62, // label: name="a", value="b"
    0x12, 0x0c, // field 2 (sample), length 12
    0x09, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xf8, 0x3f, // value=1.5 (double LE)
    0x10, 0xe8, 0x07, // timestamp=1000 (varint)
  ]);
  assert.deepEqual(encoded, expected);
});

test('encodeWriteRequest sorts labels ascending, putting __name__ first', () => {
  const encoded = encodeWriteRequest([
    {
      labels: [
        { name: 'meter_id', value: '1' },
        { name: '__name__', value: 'israel_utility_water_consumption_daily_liters' },
        { name: 'meter_serial', value: 'abc' },
      ],
      samples: [{ value: 42, timestampMs: 1_700_000_000_000 }],
    },
  ]);
  const [decoded] = decodeWriteRequest(encoded);
  assert.deepEqual(
    decoded!.labels.map((l) => l.name),
    ['__name__', 'meter_id', 'meter_serial'],
  );
  assert.equal(decoded!.labels[0]!.value, 'israel_utility_water_consumption_daily_liters');
});

test('round-trips multiple series and multiple samples per series', () => {
  const input: RwTimeSeries[] = [
    {
      labels: [
        { name: '__name__', value: 'israel_utility_electricity_consumption_daily_kwh' },
        { name: 'contract_id', value: '900123456' },
      ],
      samples: [
        { value: 12.3, timestampMs: 1_735_689_600_000 },
        { value: 15.1, timestampMs: 1_735_776_000_000 },
      ],
    },
    {
      labels: [
        { name: '__name__', value: 'israel_utility_water_consumption_monthly_liters' },
        { name: 'meter_id', value: '55123' },
        { name: 'meter_serial', value: '' },
      ],
      samples: [{ value: 12_345.6, timestampMs: 1_735_689_600_000 }],
    },
  ];

  const decoded = decodeWriteRequest(encodeWriteRequest(input));
  assert.equal(decoded.length, 2);
  assert.equal(decoded[0]!.samples.length, 2);
  assert.deepEqual(decoded[0]!.samples, input[0]!.samples);
  assert.equal(decoded[1]!.samples[0]!.value, 12_345.6);
});
