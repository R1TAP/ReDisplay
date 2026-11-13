package com.redisplay.client;

import android.media.MediaCodec;
import android.media.MediaFormat;
import android.media.MediaCodecInfo;
import android.util.Range;
import android.util.LongSparseArray;

import org.json.JSONException;
import org.json.JSONObject;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.SystemClock;
import android.util.Log;
import android.view.Surface;

import java.io.IOException;
import java.nio.ByteBuffer;
import java.util.ArrayDeque;
import java.util.Arrays;

public class VideoDecoder {
    private static final String TAG = "ReDisplay_Decoder";
    private static final String MIME_TYPE = MediaFormat.MIMETYPE_VIDEO_AVC;

    private final HandlerThread callbackThread = new HandlerThread("ReDisplay-MediaCodec");
    private final Handler callbackHandler;
    private final ArrayDeque<Integer> inputBuffers = new ArrayDeque<>();
    private MediaCodec codec;
    private Surface surface;
    private int width;
    private int height;
    private int fps;
    private boolean hasConfig;
    private boolean released;
    private boolean needsIdr = true;
    private boolean flushAtIdr;
    private long decodedFrames;
    private long submittedFrames;
    private long droppedFrames;
    private long abandonedFrames;
    private int pendingFrames;
    private int pendingPeak;
    private final long[] decodeTimesUs = new long[512];
    private final long[] surfaceGapsUs = new long[512];
    private int decodeSamples;
    private int surfaceSamples;
    private long lastSurfaceUs;
    private float panelHz;
    private volatile long expectedPresentationNs;
    private long lastRequestedVsyncNs;
    private final LongSparseArray<Long> traceIds = new LongSparseArray<>();
    private final ArrayDeque<long[]> traceOutput = new ArrayDeque<>();

    public VideoDecoder() {
        callbackThread.start();
        callbackHandler = new Handler(callbackThread.getLooper());
    }

    public synchronized void setPanelRefreshRate(float hz) {
        panelHz = hz;
    }

    public void setExpectedPresentationTime(long timestampNs) {
        expectedPresentationNs = timestampNs;
    }

    private long renderTimestampNs(long now) {
        if (fps != 120 || Math.abs(panelHz - fps) > 0.5f) return now;
        final long anchor = expectedPresentationNs;
        if (anchor <= 0 || Math.abs(anchor - now) > 100_000_000L) return 0;
        final long period = Math.round(1_000_000_000.0 / panelHz);
        final long earliest = now + 2_000_000L;
        final long firstVsync = anchor + Math.floorDiv(earliest - anchor + period - 1, period) * period;
        final long vsync = Math.max(firstVsync, lastRequestedVsyncNs + period);
        if (vsync - now > 2 * period + 1_000_000L) {
            lastRequestedVsyncNs = 0;
            return 0;
        }
        lastRequestedVsyncNs = vsync;
        return vsync - 750_000L;
    }

    public synchronized void setSurface(Surface newSurface) {
        surface = newSurface;
        if (codec != null && newSurface != null && newSurface.isValid()) {
            try {
                codec.setOutputSurface(newSurface);
                return;
            } catch (RuntimeException e) {
                Log.w(TAG, "Output surface changed, recreating decoder", e);
            }
        }
        closeCodec();
        openCodec();
    }

    public synchronized void reconfigure(int newWidth, int newHeight, int newFps) {
        closeCodec();
        width = newWidth;
        height = newHeight;
        fps = newFps;
        hasConfig = true;
        decodedFrames = 0;
        submittedFrames = 0;
        abandonedFrames = 0;
        pendingPeak = 0;
        droppedFrames = 0;
        decodeSamples = 0;
        surfaceSamples = 0;
        lastSurfaceUs = 0;
        traceOutput.clear();
        panelHz = 0;
        openCodec();
    }

    public synchronized boolean waitUntilReady() throws InterruptedException {
        long deadline = SystemClock.elapsedRealtime() + 1800;
        while (!released && hasConfig && inputBuffers.isEmpty()) {
            long remaining = deadline - SystemClock.elapsedRealtime();
            if (remaining <= 0) break;
            wait(remaining);
        }
        return !inputBuffers.isEmpty();
    }

    public synchronized void endStream() {
        hasConfig = false;
        closeCodec();
    }

    private void openCodec() {
        if (released || !hasConfig || surface == null || !surface.isValid()) return;
        try {
            codec = MediaCodec.createDecoderByType(MIME_TYPE);
            codec.setCallback(new MediaCodec.Callback() {
                @Override
                public void onInputBufferAvailable(MediaCodec source, int index) {
                    synchronized (VideoDecoder.this) {
                        if (codec != source) return;
                        inputBuffers.addLast(index);
                        VideoDecoder.this.notifyAll();
                    }
                }

                @Override
                public void onOutputBufferAvailable(MediaCodec source, int index, MediaCodec.BufferInfo info) {
                    synchronized (VideoDecoder.this) {
                        if (codec != source) return;
                        try {
                            boolean picture = info.size > 0 && (info.flags & MediaCodec.BUFFER_FLAG_CODEC_CONFIG) == 0;
                            long outputUs = System.nanoTime() / 1000;
                            long submittedUs = 0;
                            if (picture) {
                                decodedFrames++;
                                if (pendingFrames > 0) pendingFrames--;
                                long duration = outputUs - info.presentationTimeUs;
                                if (duration >= 0) decodeTimesUs[decodeSamples++ % decodeTimesUs.length] = duration;
                            }
                            boolean render = picture && surface != null && surface.isValid();
                            if (render) {
                                source.releaseOutputBuffer(index, renderTimestampNs(System.nanoTime()));
                                submittedUs = System.nanoTime() / 1000;
                                if (lastSurfaceUs != 0) surfaceGapsUs[surfaceSamples++ % surfaceGapsUs.length] = submittedUs - lastSurfaceUs;
                                lastSurfaceUs = submittedUs;
                                submittedFrames++;
                            } else {
                                source.releaseOutputBuffer(index, false);
                            }
                            if (picture && traceIds.size() > 0) {
                                Long id = traceIds.get(info.presentationTimeUs);
                                if (id != null) {
                                    traceIds.delete(info.presentationTimeUs);
                                    if (traceOutput.size() < 512) {
                                        traceOutput.addLast(new long[]{id, info.presentationTimeUs, outputUs, submittedUs});
                                    }
                                }
                            }
                        } catch (RuntimeException e) {
                            Log.w(TAG, "Output buffer failed", e);
                            closeCodec();
                        }
                    }
                }

                @Override
                public void onError(MediaCodec source, MediaCodec.CodecException error) {
                    synchronized (VideoDecoder.this) {
                        if (codec != source) return;
                        Log.e(TAG, "Decoder error", error);
                        closeCodec();
                    }
                }

                @Override
                public void onOutputFormatChanged(MediaCodec source, MediaFormat format) {
                    Log.i(TAG, "Output format: " + format);
                }
            }, callbackHandler);

            MediaFormat format = MediaFormat.createVideoFormat(MIME_TYPE, width, height);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                format.setInteger(MediaFormat.KEY_LOW_LATENCY, 1);
            }
            format.setInteger(MediaFormat.KEY_PRIORITY, 0);
            format.setInteger(MediaFormat.KEY_FRAME_RATE, fps);
            format.setInteger(MediaFormat.KEY_OPERATING_RATE, Math.max(fps * 10, 1200));
            codec.configure(format, surface, null, 0);
            codec.start();
            Log.i(TAG, "Decoder: " + codec.getName() + " " + width + "x" + height + " @" + fps);
        } catch (IOException | RuntimeException e) {
            Log.e(TAG, "Could not start decoder", e);
            closeCodec();
        }
    }

    // Returns false when the receiver needs a fresh IDR. The input wait bounds network-thread latency.
    public synchronized boolean decode(byte[] data, int length, long timestampUs, boolean keyFrame, long traceId) {
        if (released || !hasConfig || surface == null || !surface.isValid()) {
            droppedFrames++;
            return true;
        }
        if (codec == null && keyFrame) openCodec();
        if (codec == null || (needsIdr && !keyFrame)) {
            droppedFrames++;
            return false;
        }

        try {
            if (flushAtIdr) {
                // A failed input handoff breaks the reference chain. Start with fresh SPS/PPS and IDR.
                closeCodec();
                openCodec();
                if (codec == null) {
                    droppedFrames++;
                    return false;
                }
            }
            final MediaCodec target = codec;
            final long deadline = SystemClock.elapsedRealtime() + 12;
            while (codec == target && inputBuffers.isEmpty()) {
                long remaining = deadline - SystemClock.elapsedRealtime();
                if (remaining <= 0) break;
                wait(remaining);
            }
            if (codec != target) {
                droppedFrames++;
                return false;
            }
            Integer index = inputBuffers.pollFirst();
            if (index != null) {
                ByteBuffer input = target.getInputBuffer(index);
                if (input != null && input.capacity() >= length) {
                    input.clear();
                    input.put(data, 0, length);
                    target.queueInputBuffer(index, 0, length, timestampUs, 0);
                    if (traceId > 0 && traceIds.size() < 512) traceIds.put(timestampUs, traceId);
                    pendingPeak = Math.max(pendingPeak, ++pendingFrames);
                    needsIdr = false;
                    return true;
                }
                Log.w(TAG, "Access unit exceeded codec input capacity: " + length);
                closeCodec();
            } else {
                flushAtIdr = true;
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        } catch (RuntimeException e) {
            Log.w(TAG, "Input buffer failed", e);
            closeCodec();
        }

        needsIdr = true;
        droppedFrames++;
        return false;
    }

    static final class Stats {
        final long decoded, submitted, inputDrops, abandoned;
        final int pending, pendingPeak;
        final long[] decodeUs, surfaceGapsUs;

        Stats(long decoded, long submitted, long inputDrops, long abandoned, int pending,
              int pendingPeak, long[] decodeUs, long[] surfaceGapsUs) {
            this.decoded = decoded;
            this.submitted = submitted;
            this.inputDrops = inputDrops;
            this.abandoned = abandoned;
            this.pending = pending;
            this.pendingPeak = pendingPeak;
            this.decodeUs = decodeUs;
            this.surfaceGapsUs = surfaceGapsUs;
        }
    }

    synchronized Stats takeStats() {
        Stats stats = new Stats(decodedFrames, submittedFrames, droppedFrames, abandonedFrames,
                pendingFrames, pendingPeak, Arrays.copyOf(decodeTimesUs, Math.min(decodeSamples, decodeTimesUs.length)),
                Arrays.copyOf(surfaceGapsUs, Math.min(surfaceSamples, surfaceGapsUs.length)));
        decodeSamples = 0;
        surfaceSamples = 0;
        pendingPeak = pendingFrames;
        return stats;
    }

    synchronized long[][] takeTrace() {
        long[][] samples = traceOutput.toArray(new long[0][]);
        traceOutput.clear();
        return samples;
    }

    synchronized JSONObject describeCodec() throws JSONException {
        JSONObject result = new JSONObject();
        if (codec == null) return result;
        result.put("decoder", codec.getName());
        try {
            MediaCodecInfo info = codec.getCodecInfo();
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                result.put("hardwareAccelerated", info.isHardwareAccelerated());
            }
            MediaCodecInfo.VideoCapabilities video = info.getCapabilitiesForType(MIME_TYPE).getVideoCapabilities();
            if (video != null && video.isSizeSupported(width, height)) {
                result.put("advertisedMaxFps", video.getSupportedFrameRatesFor(width, height).getUpper());
                result.put("requestedRateSupported", video.areSizeAndRateSupported(width, height, fps));
                Range<Double> measured = video.getAchievableFrameRatesFor(width, height);
                if (measured != null) result.put("estimatedMaxFps", measured.getUpper());
            }
        } catch (RuntimeException e) {
            Log.w(TAG, "Decoder capability query unavailable", e);
        }
        return result;
    }

    private void closeCodec() {
        MediaCodec old = codec;
        codec = null;
        abandonedFrames += pendingFrames;
        pendingFrames = 0;
        lastRequestedVsyncNs = 0;
        lastSurfaceUs = 0;
        traceIds.clear();
        inputBuffers.clear();
        needsIdr = true;
        flushAtIdr = false;
        notifyAll();
        if (old == null) return;
        try { old.release(); } catch (RuntimeException e) { Log.w(TAG, "Decoder release failed", e); }
    }

    public synchronized void release() {
        released = true;
        closeCodec();
        callbackThread.quitSafely();
    }
}
