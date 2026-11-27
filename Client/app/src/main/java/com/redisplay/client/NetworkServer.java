package com.redisplay.client;

import android.hardware.display.DisplayManager;
import android.os.Build;
import android.os.SystemClock;
import android.view.Display;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import android.util.Log;

import java.io.BufferedInputStream;
import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.EOFException;
import java.io.IOException;
import android.net.LocalServerSocket;
import android.net.LocalSocket;
import android.system.Os;
import android.system.OsConstants;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Locale;

public class NetworkServer implements Runnable {
    private static final String TAG = "ReDisplay_Net";
    private static final int MAGIC = 0x52445350; // RDSP
    private static final int VIDEO = 1;
    private static final int CONFIG = 2;
    private static final int PING = 3;
    private static final int PONG = 4;
    private static final int REQUEST_IDR = 5;
    private static final int READY = 6;
    private static final int CLIENT_INFO = 7;
    private static final int CLIENT_STATS = 8;
    private static final int CLIENT_TRACE = 9;
    static final int POINTER = 10;
    private static final int INPUT_MODE = 11;
    private static final int TELEMETRY_V1 = 0x1301;
    private static final int TRACE_V1 = 0x1302;
    private static final int MAX_CONTROL_BYTES = 4096;
    private static final int MAX_VIDEO_BYTES = 4 * 1024 * 1024;

    public interface StatusListener {
        void onConnected(boolean inputEnabled);
        void onInputModeChanged(boolean enabled);
        void onDisconnected();
        void onResolutionChanged(int width, int height, int fps);
        void onStatsUpdate(float fps, int bitrateKbps);
    }

    private final VideoDecoder decoder;
    private final StatusListener listener;
    private final DisplayManager displays;
    private volatile boolean running;
    private LocalServerSocket serverSocket;
    private final String endpoint, bootstrap;
    private volatile PointerSender pointers;
    private volatile long lastPacketMs;
    PointerSender pointers() { return pointers; }
    private LocalSocket clientSocket;
    private Thread serverThread;

    public NetworkServer(VideoDecoder decoder, StatusListener listener, DisplayManager displays, String endpoint, String bootstrap) {
        this.decoder = decoder;
        this.listener = listener;
        this.displays = displays;
        this.endpoint = endpoint;
        this.bootstrap = bootstrap;
    }

    public synchronized void start() {
        if (serverThread != null || endpoint == null || !endpoint.matches("redisplay13_[0-9a-f]{32}") ||
                bootstrap == null || !bootstrap.matches("[0-9a-f]{64}")) return;
        running = true;
        serverThread = new Thread(this, "ReDisplay-NetServer");
        serverThread.start();
    }

    public synchronized void stop() {
        running = false;
        if (clientSocket != null) {
            closePeer(clientSocket);
        }
        if (serverSocket != null) {
            try { Os.shutdown(serverSocket.getFileDescriptor(), OsConstants.SHUT_RDWR); } catch (Exception ignored) {}
            try { serverSocket.close(); } catch (IOException ignored) {}
        }
        if (serverThread != null) serverThread.interrupt();
    }

    @Override
    public void run() {
        byte[] payload = new byte[MAX_VIDEO_BYTES];
        try {
            LocalServerSocket listenerSocket = new LocalServerSocket(endpoint);
            try {
                synchronized (this) {
                    if (!running) return;
                    serverSocket = listenerSocket;
                }
                while (running) {
                    LocalSocket socket = listenerSocket.accept();
                    try {
                        int uid = socket.getPeerCredentials().getUid();
                        if (uid != 2000 && uid != 0) continue;
                        synchronized (this) {
                            if (!running) return;
                            clientSocket = socket;
                        }
                        socket.setSoTimeout(4500);
                        lastPacketMs = SystemClock.elapsedRealtime();
                        Thread watchdog = new Thread(() -> {
                            try {
                                while (!Thread.interrupted()) {
                                    Thread.sleep(500);
                                    if (SystemClock.elapsedRealtime() - lastPacketMs > 5000) {
                                        closePeer(socket);
                                        return;
                                    }
                                }
                            } catch (InterruptedException ignored) {}
                        }, "ReDisplay-Keepalive");
                        watchdog.start();
                        try { handleClient(socket, payload); }
                        finally { watchdog.interrupt(); }
                    } catch (IOException e) {
                        if (running) Log.i(TAG, "Connection ended: " + e.getMessage());
                    } finally {
                        closePeer(socket);
                        synchronized (this) { clientSocket = null; }
                    }
                }
            } finally { listenerSocket.close(); }
        } catch (IOException e) {
            if (running) Log.w(TAG, "Listener failed", e);
        } finally {
            synchronized (this) { serverSocket = null; }
        }
    }

    private static void closePeer(LocalSocket socket) {
        try { socket.shutdownInput(); } catch (IOException ignored) {}
        try { socket.shutdownOutput(); } catch (IOException ignored) {}
        try { socket.close(); } catch (IOException ignored) {}
    }

    private static final class ReceivedVideo {
        private long frames;
        private long bytes;

        synchronized void add(int payloadSize) {
            frames++;
            bytes += payloadSize + 20;
        }

        synchronized long[] snapshot() {
            return new long[]{frames, bytes};
        }
    }

    private void handleClient(LocalSocket socket, byte[] payload) throws IOException {
        DataInputStream in = new DataInputStream(new BufferedInputStream(socket.getInputStream(), 64 * 1024));
        DataOutputStream out = new DataOutputStream(socket.getOutputStream());
        SessionAuth.verify(in, out, bootstrap);
        ReceivedVideo received = new ReceivedVideo();
        boolean configured = false;
        boolean trace = false;
        long lastIdrRequest = -100;
        long lastPresentationUs = 0;
        Thread reporter = null;
        Thread inputWriter = null;

        try {
            while (running) {
                if (in.readInt() != MAGIC) throw new IOException("Invalid packet magic");
                int type = in.readUnsignedByte();
                int flags = in.readUnsignedByte();
                int reserved = in.readUnsignedShort();
                long timestampUs = in.readLong();
                int size = in.readInt();

                if (type == CONFIG && size == 12 && !configured) {
                    int w = in.readInt();
                    int h = in.readInt();
                    int fps = in.readInt();
                    if (w <= 0 || w > 8192 || h <= 0 || h > 8192 || fps <= 0 || fps > 240) {
                        throw new IOException("Invalid stream dimensions or refresh rate");
                    }
                    configured = true;
                    Log.i(TAG, "Config received: " + w + "x" + h + " @" + fps + "Hz");
                    listener.onResolutionChanged(w, h, fps);
                    decoder.reconfigure(w, h, fps);
                    try {
                        if (!decoder.waitUntilReady()) throw new IOException("Decoder did not become ready");
                    } catch (InterruptedException e) {
                        Thread.currentThread().interrupt();
                        throw new IOException("Interrupted while waiting for decoder", e);
                    }
                    if ((flags & ~1) != 0 || (reserved != TRACE_V1 && reserved != TELEMETRY_V1))
                        throw new IOException("Unsupported session configuration");
                    sendControl(out, READY, 0, null);
                    boolean inputEnabled = (flags & 1) != 0;
                    pointers = new PointerSender(out, () -> closePeer(socket), inputEnabled);
                    inputWriter = new Thread(pointers, "ReDisplay-Pointer");
                    inputWriter.start();
                    listener.onConnected(inputEnabled);
                    trace = reserved == TRACE_V1;
                    final int telemetry = reserved;
                    reporter = new Thread(() -> report(socket, out, received, telemetry), "ReDisplay-Telemetry");
                    reporter.start();
                } else if (type == VIDEO && configured && size > 0 && size <= payload.length) {
                    in.readFully(payload, 0, size);
                    received.add(size);
                    long presentationUs = Math.max(lastPresentationUs + 1, System.nanoTime() / 1000);
                    lastPresentationUs = presentationUs;
                    if (!decoder.decode(payload, size, presentationUs, (flags & 1) != 0, trace ? timestampUs : 0)) {
                        long now = SystemClock.elapsedRealtime();
                        if (now - lastIdrRequest >= 100) {
                            sendControl(out, REQUEST_IDR, 0, null);
                            lastIdrRequest = now;
                        }
                    }
                } else if (configured && type == INPUT_MODE && size == 0 && flags <= 1 && timestampUs > 0) {
                    pointers.setMode(flags == 1, timestampUs);
                    sendBytes(out, INPUT_MODE, flags, timestampUs, new byte[0]);
                    listener.onInputModeChanged(flags == 1);
                } else if (configured && type == PING && size == 0) {
                    if (trace) {
                        long receiveUs = System.nanoTime() / 1000;
                        synchronized (out) {
                            byte[] times = ByteBuffer.allocate(16).putLong(receiveUs)
                                    .putLong(System.nanoTime() / 1000).array();
                            sendBytes(out, PONG, timestampUs, times);
                        }
                    } else {
                        sendControl(out, PONG, timestampUs, null);
                    }
                } else {
                    throw new IOException("Invalid packet type/size: " + type + "/" + size);
                }
                lastPacketMs = SystemClock.elapsedRealtime();
            }
        } finally {
            PointerSender sender = pointers;
            pointers = null;
            if (sender != null) sender.close();
            closePeer(socket);
            if (inputWriter != null) {
                try { inputWriter.join(); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
            }
            if (configured) {
                decoder.endStream();
                if (running) listener.onDisconnected();
            }
            if (reporter != null) {
                reporter.interrupt();
                try { socket.close(); } catch (IOException ignored) {}
                try { reporter.join(); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
            }
        }
    }

    private void report(LocalSocket socket, DataOutputStream out, ReceivedVideo received, int telemetryVersion) {
        boolean trace = telemetryVersion == TRACE_V1;
        boolean telemetry = trace || telemetryVersion == TELEMETRY_V1;
        long lastTime = SystemClock.elapsedRealtime();
        long lastReceived = 0, lastBytes = 0, lastDecoded = 0, lastSubmitted = 0;
        try {
            if (telemetry) sendControl(out, CLIENT_INFO, 0, describeDevice());
            while (running && !Thread.currentThread().isInterrupted()) {
                Thread.sleep(1000);
                long now = SystemClock.elapsedRealtime();
                long windowMs = now - lastTime;
                double seconds = windowMs / 1000.0;
                long[] tcp = received.snapshot();
                VideoDecoder.Stats decoderStats = decoder.takeStats();
                double rxFps = (tcp[0] - lastReceived) / seconds;
                double decodedFps = (decoderStats.decoded - lastDecoded) / seconds;
                double submittedFps = (decoderStats.submitted - lastSubmitted) / seconds;
                double mbps = (tcp[1] - lastBytes) * 8.0 / windowMs / 1000.0;
                JSONObject decode = timing(decoderStats.decodeUs);
                JSONObject surface = timing(decoderStats.surfaceGapsUs);
                Log.i(TAG, String.format(Locale.US,
                        "[Android] TCP %.1f FPS | Decoder %.1f FPS | %.1f Mbps | Decode drops %d | Decode P95 %.2f ms | Surface submit gap P95 %.2f ms",
                        rxFps, decodedFps, mbps, decoderStats.inputDrops, decode.optDouble("p95Ms", 0),
                        surface.optDouble("p95Ms", 0)));
                listener.onStatsUpdate((float) decodedFps, (int) (mbps * 1000));

                if (telemetry) {
                    JSONObject stats = new JSONObject()
                            .put("windowMs", windowMs).put("receivedFrames", tcp[0]).put("receivedBytes", tcp[1])
                            .put("receivedFps", rxFps).put("decodedFps", decodedFps).put("surfaceFps", submittedFps)
                            .put("decodedFrames", decoderStats.decoded).put("surfaceFrames", decoderStats.submitted)
                            .put("inputDrops", decoderStats.inputDrops).put("abandonedFrames", decoderStats.abandoned)
                            .put("pendingFrames", decoderStats.pending).put("pendingPeak", decoderStats.pendingPeak)
                            .put("decode", decode).put("surfaceGap", surface)
                            .put("inputWait", timing(decoderStats.inputWait)).put("codecResidence", timing(decoderStats.residence));
                    Display.Mode mode = displayMode();
                    if (mode != null) {
                        stats.put("displayHz", mode.getRefreshRate());
                    }
                    sendControl(out, CLIENT_STATS, 0, stats);
                    if (trace) sendTrace(out, decoder.takeTrace());
                }
                lastTime = now;
                lastReceived = tcp[0];
                lastBytes = tcp[1];
                lastDecoded = decoderStats.decoded;
                lastSubmitted = decoderStats.submitted;
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        } catch (JSONException e) {
            Log.w(TAG, "Telemetry data unavailable", e);
        } catch (IOException e) {
            try { socket.close(); } catch (IOException ignored) {}
        }
    }

    private Display.Mode displayMode() {
        Display display = displays == null ? null : displays.getDisplay(Display.DEFAULT_DISPLAY);
        return display == null ? null : display.getMode();
    }

    private JSONObject describeDevice() throws JSONException {
        JSONObject result = decoder.describeCodec()
                .put("model", Build.MODEL).put("androidVersion", Build.VERSION.RELEASE)
                .put("sdk", Build.VERSION.SDK_INT);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) result.put("soc", Build.SOC_MODEL);
        Display display = displays == null ? null : displays.getDisplay(Display.DEFAULT_DISPLAY);
        if (display != null) {
            Display.Mode current = display.getMode();
            result.put("panelWidth", current.getPhysicalWidth()).put("panelHeight", current.getPhysicalHeight());
            JSONArray modes = new JSONArray();
            for (Display.Mode mode : display.getSupportedModes()) {
                modes.put(new JSONObject().put("width", mode.getPhysicalWidth()).put("height", mode.getPhysicalHeight())
                        .put("hz", mode.getRefreshRate()));
                if (modes.length() >= 32) break;
            }
            result.put("displayModes", modes);
        }
        return result;
    }

    private static JSONObject timing(long[] samples) throws JSONException {
        if (samples.length == 0) return new JSONObject().put("samples", 0);
        Arrays.sort(samples);
        long totalUs = 0;
        for (long us : samples) totalUs += us;
        return new JSONObject().put("samples", samples.length)
                .put("avgMs", totalUs / (1000.0 * samples.length))
                .put("p50Ms", percentileMs(samples, 50)).put("p95Ms", percentileMs(samples, 95))
                .put("p99Ms", percentileMs(samples, 99));
    }

    private static double percentileMs(long[] sorted, int percentile) {
        return sorted[(sorted.length * percentile - 1) / 100] / 1000.0;
    }

    private void sendTrace(DataOutputStream out, long[][] frames) throws IOException {
        int maxFrames = MAX_CONTROL_BYTES / 32;
        for (int start = 0; start < frames.length; start += maxFrames) {
            int count = Math.min(maxFrames, frames.length - start);
            ByteBuffer payload = ByteBuffer.allocate(count * 32);
            for (int i = start; i < start + count; i++) {
                for (long time : frames[i]) payload.putLong(time);
            }
            sendBytes(out, CLIENT_TRACE, 0, payload.array());
        }
    }

    private void sendControl(DataOutputStream out, int type, long timestampUs, JSONObject json) throws IOException {
        sendBytes(out, type, timestampUs, json == null ? new byte[0] : json.toString().getBytes(StandardCharsets.UTF_8));
    }

    static void sendBytes(DataOutputStream out, int type, long timestampUs, byte[] payload) throws IOException {
        sendBytes(out, type, 0, timestampUs, payload);
    }

    private static void sendBytes(DataOutputStream out, int type, int flags, long timestampUs, byte[] payload) throws IOException {
        if (payload.length > MAX_CONTROL_BYTES) throw new IOException("Control message too large");
        ByteBuffer message = ByteBuffer.allocate(20 + payload.length);
        message.putInt(MAGIC).put((byte) type).put((byte) flags).putShort((short) 0)
                .putLong(timestampUs).putInt(payload.length).put(payload);
        synchronized (out) {
            out.write(message.array());
        }
    }
}
