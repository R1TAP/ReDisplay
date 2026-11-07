package com.redisplay.client;

import android.media.MediaCodec;
import android.media.MediaFormat;
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
    private long renderedFrames;
    private long droppedFrames;
    private final long[] decodeTimesUs = new long[512];
    private final long[] surfaceGapsUs = new long[512];
    private int decodeSamples;
    private int surfaceSamples;
    private long lastSurfaceUs;

    public VideoDecoder() {
        callbackThread.start();
        callbackHandler = new Handler(callbackThread.getLooper());
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
        renderedFrames = 0;
        droppedFrames = 0;
        decodeSamples = 0;
        surfaceSamples = 0;
        lastSurfaceUs = 0;
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
                            boolean render = info.size > 0 && surface != null && surface.isValid();
                            if (render) {
                                // Timestamp against Android VSYNC so a faster stream can present its newest frame.
                                source.releaseOutputBuffer(index, System.nanoTime());
                                long submittedUs = System.nanoTime() / 1000;
                                long duration = submittedUs - info.presentationTimeUs;
                                if (duration >= 0) decodeTimesUs[decodeSamples++ % decodeTimesUs.length] = duration;
                                if (lastSurfaceUs != 0) surfaceGapsUs[surfaceSamples++ % surfaceGapsUs.length] = submittedUs - lastSurfaceUs;
                                lastSurfaceUs = submittedUs;
                                renderedFrames++;
                            } else {
                                source.releaseOutputBuffer(index, false);
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
    public synchronized boolean decode(byte[] data, int length, long timestampUs, boolean keyFrame) {
        if (released || !hasConfig || surface == null || !surface.isValid()) return true;
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
                if (codec == null) return false;
            }
            final MediaCodec target = codec;
            final long deadline = SystemClock.elapsedRealtime() + 12;
            while (codec == target && inputBuffers.isEmpty()) {
                long remaining = deadline - SystemClock.elapsedRealtime();
                if (remaining <= 0) break;
                wait(remaining);
            }
            if (codec != target) return false;
            Integer index = inputBuffers.pollFirst();
            if (index != null) {
                ByteBuffer input = target.getInputBuffer(index);
                if (input != null && input.capacity() >= length) {
                    input.clear();
                    input.put(data, 0, length);
                    target.queueInputBuffer(index, 0, length, timestampUs, 0);
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

    public synchronized double[] takeTimingP95Ms() {
        double[] result = { percentileMs(decodeTimesUs, decodeSamples), percentileMs(surfaceGapsUs, surfaceSamples) };
        decodeSamples = 0;
        surfaceSamples = 0;
        return result;
    }

    private static double percentileMs(long[] samples, int count) {
        count = Math.min(count, samples.length);
        if (count == 0) return 0;
        Arrays.sort(samples, 0, count);
        return samples[(count * 95 - 1) / 100] / 1000.0;
    }

    public synchronized long getRenderedFrames() { return renderedFrames; }
    public synchronized long getDroppedFrames() { return droppedFrames; }

    private void closeCodec() {
        MediaCodec old = codec;
        codec = null;
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
