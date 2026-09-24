package com.redisplay.client;

import android.media.MediaCodec;
import android.media.MediaFormat;
import android.util.Log;
import android.view.Surface;

import java.io.IOException;
import java.nio.ByteBuffer;

public class VideoDecoder {
    private static final String TAG = "ReDisplay_Decoder";
    private static final String MIME_TYPE = MediaFormat.MIMETYPE_VIDEO_AVC;

    private MediaCodec codec;
    private Surface surface;
    private int width = 2800;
    private int height = 1752;
    private int fps = 120;
    private boolean isConfigured = false;
    private final MediaCodec.BufferInfo bufferInfo = new MediaCodec.BufferInfo();

    // Stats
    private long frameCount = 0;
    private long lastFpsTime = System.currentTimeMillis();
    private float currentFps = 0.0f;

    public VideoDecoder(int width, int height) {
        this.width = width;
        this.height = height;
    }

    public synchronized void setSurface(Surface newSurface) {
        this.surface = newSurface;
        if (newSurface == null || !newSurface.isValid()) {
            return;
        }

        if (codec != null && isConfigured) {
            try {
                codec.setOutputSurface(newSurface);
                Log.i(TAG, "Dynamic setOutputSurface succeeded");
                return;
            } catch (Exception e) {
                Log.w(TAG, "setOutputSurface failed, re-initializing: " + e.getMessage());
            }
        }
        init();
    }

    public synchronized void init() {
        if (surface == null || !surface.isValid()) {
            Log.w(TAG, "Surface is not ready, skipping init");
            return;
        }
        if (codec != null) {
            release();
        }
        try {
            codec = MediaCodec.createDecoderByType(MIME_TYPE);
            MediaFormat format = MediaFormat.createVideoFormat(MIME_TYPE, width, height);

            // Snapdragon 8 Gen 2 / Android 11+ Low Latency Keys
            try {
                format.setInteger(MediaFormat.KEY_LOW_LATENCY, 1);
            } catch (Exception ignored) {}
            try {
                format.setInteger(MediaFormat.KEY_PRIORITY, 0); // Realtime
            } catch (Exception ignored) {}
            try {
                format.setInteger(MediaFormat.KEY_FRAME_RATE, fps);
            } catch (Exception ignored) {}
            try {
                format.setInteger(MediaFormat.KEY_OPERATING_RATE, Math.max(fps * 10, 1200)); // Clock boost
            } catch (Exception ignored) {}

            codec.configure(format, surface, null, 0);
            codec.start();
            isConfigured = true;
            Log.i(TAG, "[Stage 6 MediaCodec Param] KEY_FRAME_RATE=" + fps + ", KEY_OPERATING_RATE=" + Math.max(fps * 10, 1200));
            Log.i(TAG, "Hardware decoder started: " + codec.getName() + " (" + width + "x" + height + " @" + fps + "Hz)");
        } catch (IOException e) {
            Log.e(TAG, "Failed to create decoder: " + e.getMessage(), e);
        }
    }

    public synchronized void reconfigure(int newWidth, int newHeight, int newFps) {
        if (this.width != newWidth || this.height != newHeight || this.fps != newFps || !isConfigured) {
            this.width = newWidth;
            this.height = newHeight;
            this.fps = (newFps > 0) ? newFps : 120;
            init();
        }
    }

    private long inQueuedCount = 0;
    private long inDroppedCount = 0;

    public synchronized void decode(byte[] data, int offset, int length, long timestampUs, boolean isKeyFrame) {
        if (!isConfigured || codec == null || surface == null || !surface.isValid()) {
            return;
        }

        try {
            int inIndex = codec.dequeueInputBuffer(1000); // 1ms max
            if (inIndex >= 0) {
                inQueuedCount++;
                ByteBuffer inBuffer = codec.getInputBuffer(inIndex);
                if (inBuffer != null) {
                    inBuffer.clear();
                    inBuffer.put(data, offset, length);
                    int flags = isKeyFrame ? MediaCodec.BUFFER_FLAG_KEY_FRAME : 0;
                    codec.queueInputBuffer(inIndex, 0, length, timestampUs, flags);
                }
            } else {
                inDroppedCount++;
            }

            // Immediately dequeue available outputs with 0 timeout for lowest latency
            int outIndex = codec.dequeueOutputBuffer(bufferInfo, 0);
            while (outIndex >= 0) {
                // Render directly to surface with zero delay
                codec.releaseOutputBuffer(outIndex, true);
                frameCount++;
                outIndex = codec.dequeueOutputBuffer(bufferInfo, 0);
            }

            // Update FPS stats every second
            long now = System.currentTimeMillis();
            if (now - lastFpsTime >= 1000) {
                double elapsedSec = (now - lastFpsTime) / 1000.0;
                currentFps = (float) (frameCount / elapsedSec);
                Log.i(TAG, "[Stage 6 MediaCodec] Decoded: " + String.format(java.util.Locale.US, "%.1f", currentFps) + " FPS | Queued: " + inQueuedCount + ", Dropped: " + inDroppedCount);
                frameCount = 0;
                inQueuedCount = 0;
                inDroppedCount = 0;
                lastFpsTime = now;
            }
        } catch (Exception e) {
            Log.e(TAG, "Decode error: " + e.getMessage());
        }
    }

    public float getFps() {
        return currentFps;
    }

    public synchronized void release() {
        if (codec != null) {
            try {
                codec.stop();
                codec.release();
            } catch (Exception ignored) {}
            codec = null;
            isConfigured = false;
        }
    }
}
