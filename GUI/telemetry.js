const MIN_WINDOW_US = 500000;
const MAX_CLOCK_RTT_US = 10000;

function timing(values) {
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const percentile = p => sorted[Math.ceil(p * sorted.length) - 1];
    return {
        samples: sorted.length,
        avgMs: sorted.reduce((sum, value) => sum + value, 0) / sorted.length / 1000,
        p50Ms: percentile(0.5) / 1000,
        p95Ms: percentile(0.95) / 1000,
        p99Ms: percentile(0.99) / 1000
    };
}

function summarizeTrace(hostBatches, clientBatches, clocks) {
    const estimates = clocks.map(({ hostSendUs, clientReceiveUs, clientSendUs, hostReceiveUs }) => ({
        at: (hostSendUs + hostReceiveUs) / 2,
        rtt: (hostReceiveUs - hostSendUs) - (clientSendUs - clientReceiveUs),
        offset: ((clientReceiveUs - hostSendUs) + (clientSendUs - hostReceiveUs)) / 2
    })).filter(sample => sample.rtt >= 0 && sample.rtt <= MAX_CLOCK_RTT_US);
    const clients = new Map(clientBatches.flat().map(frame => [frame[0], frame]));
    const captureToEncode = [], encodeToSend = [], sendToReceive = [];
    const receiveToDecode = [], decodeToSurface = [], captureToSurface = [], uncertainty = [];
    for (const [id, encoded, sent] of hostBatches.flat()) {
        const frame = clients.get(id);
        if (!frame) continue;
        const [, receive, decode, surface] = frame;
        captureToEncode.push(encoded - id);
        encodeToSend.push(sent - encoded);
        receiveToDecode.push(decode - receive);
        if (surface) decodeToSurface.push(surface - decode);
        let nearest;
        for (const estimate of estimates) {
            if (Math.abs(estimate.at - sent) <= 3000000 && (!nearest || estimate.rtt < nearest.rtt)) nearest = estimate;
        }
        if (!nearest) continue;
        uncertainty.push(nearest.rtt / 2);
        sendToReceive.push(receive - nearest.offset - sent);
        if (surface) captureToSurface.push(surface - nearest.offset - id);
    }
    return {
        matchedFrames: captureToEncode.length, usableClockSamples: estimates.length,
        captureToEncode: timing(captureToEncode), encodeToSend: timing(encodeToSend),
        sendToReceive: timing(sendToReceive), receiveToDecode: timing(receiveToDecode),
        decodeToSurface: timing(decodeToSurface), captureToSurface: timing(captureToSurface),
        clockHalfRtt: timing(uncertainty)
    };
}

function parseLayerLatency(output) {
    const samples = [];
    for (const line of output.split(/\r?\n/).slice(1)) {
        const columns = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)$/);
        if (!columns) continue;
        const present = BigInt(columns[2]);
        const ready = BigInt(columns[3]);
        const invalid = 9223372036854775807n;
        if (present <= 0n || present === invalid) continue;
        samples.push([Number(present / 1000n), ready > 0n && ready < invalid ? Number(ready / 1000n) : 0]);
    }
    return samples;
}

function summarizePresentation(samples) {
    const ordered = [...new Map(samples).entries()].sort((a, b) => a[0] - b[0]);
    const gaps = [];
    const readyToPresent = [];
    for (let i = 0; i < ordered.length; i++) {
        const [present, ready] = ordered[i];
        if (i) gaps.push(present - ordered[i - 1][0]);
        if (ready && ready <= present) readyToPresent.push(present - ready);
    }
    const span = ordered.length > 1 ? ordered.at(-1)[0] - ordered[0][0] : 0;
    return {
        samples: ordered.length,
        fps: span >= MIN_WINDOW_US ? gaps.length * 1000000 / span : null,
        interval: timing(gaps), layerReadyToPresent: timing(readyToPresent),
        intervalsOver25Ms: gaps.filter(gap => gap > 25000).length
    };
}

module.exports = { summarizeTrace, parseLayerLatency, summarizePresentation };
