const assert = require('node:assert/strict');
const { summarizeTrace, parseLayerLatency, summarizePresentation } = require('../GUI/telemetry');

const clock = { hostSendUs: 1_000_000, hostReceiveUs: 1_002_000, clientReceiveUs: 1_011_000, clientSendUs: 1_011_000 };
const slow = { ...clock, hostReceiveUs: 1_050_000 };
const trace = summarizeTrace(
    [[[1_002_000, 1_005_000, 1_006_000], [1_003_000, 1_006_000, 1_007_000]]],
    [[[1_002_000, 1_017_000, 1_021_000, 1_022_000], [1_003_000, 1_018_000, 1_022_000, 0]]],
    [slow, clock]
);
assert.equal(trace.matchedFrames, 2);
assert.equal(trace.usableClockSamples, 1);
assert.equal(trace.captureToEncode.p95Ms, 3);
assert.equal(trace.sendToReceive.p95Ms, 1);
assert.equal(trace.captureToSurface.samples, 1);
assert.equal(trace.captureToSurface.p95Ms, 10);
assert.equal(trace.clockHalfRtt.p95Ms, 1);
assert.equal(summarizeTrace([], [], []).captureToSurface, null);

const presentation = parseLayerLatency([
    '8333333', '0 0 0', '0 9223372036854775807 0', '0 7000000000 6995000000',
    '0 8000000000 7995000000', 'ignored'
].join('\n'));
assert.deepEqual(presentation, [[7_000_000, 6_995_000], [8_000_000, 7_995_000]]);
const measured = summarizePresentation([...presentation, presentation[0]]);
assert.equal(measured.samples, 2);
assert.equal(measured.fps, 1);
assert.equal(measured.layerReadyToPresent.p95Ms, 5);
assert.equal(summarizePresentation(presentation.slice(0, 1)).fps, null);
console.log('Clock offset, matched stages, invalid and duplicate presentation timestamps passed.');
