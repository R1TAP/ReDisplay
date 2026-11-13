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
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Locale;

public class NetworkServer implements Runnable {
    private static final String TAG = "ReDisplay_Net";
    public static final int PORT = 27185;
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
    private static final int TELEMETRY_V1 = 0x1201;
    private static final int TRACE_V1 = 0x1202;
    private static final int MAX_CONTROL_BYTES = 4096;
    private static final int MAX_VIDEO_BYTES = 4 * 1024 * 1024;

    public interface StatusListener {
        void onConnected(String hostInfo);
        void onDisconnected();
        void onResolutionChanged(int width, int height, int fps);
        void onStatsUpdate(float fps, int bitrateKbps);
    }

    private final VideoDecoder decoder;
    private final StatusListener listener;
    private final DisplayManager displays;
    private volatile boolean running;
    private ServerSocket serverSocket;
    private Socket clientSocket;
    private Thread serverThread;

    public NetworkServer(VideoDecoder decoder, StatusListener listener, DisplayManager displays) {
        this.decoder = decoder;
        this.listener = listener;
        this.displays = displays;
    }

    public synchronized void start() {
        if (serverThread != null) return;
        running = true;
        serverThread = new Thread(this, "ReDisplay-NetServer");
        serverThread.start();
    }

    public synchronized void stop() {
        running = false;
        if (clientSocket != null) {
            try { clientSocket.close(); } catch (IOException ignored) {}
        }
        if (serverSocket != null) {
            try { serverSocket.close(); } catch (IOException ignored) {}
        }
        if (serverThread != null) serverThread.interrupt();
    }

    @Override
    public void run() {
        byte[] payload = new byte[MAX_VIDEO_BYTES];
        while (running) {
            try (ServerSocket listenerSocket = new ServerSocket()) {
                synchronized (this) {
                    if (!running) break;
                    serverSocket = listenerSocket;
                }
                listenerSocket.setReuseAddress(true);
                listenerSocket.setReceiveBufferSize(256 * 1024);
                listenerSocket.bind(new InetSocketAddress(InetAddress.getByName("127.0.0.1"), PORT));
                Log.i(TAG, "Listening via ADB on 127.0.0.1:" + PORT);
                while (running) {
                    try (Socket socket = listenerSocket.accept()) {
                        synchronized (this) {
                            if (!running) break;
                            clientSocket = socket;
                        }
                        socket.setTcpNoDelay(true);
                        socket.setSoTimeout(3500);
                        handleClient(socket, payload);
                    } catch (EOFException e) {
                        Log.i(TAG, "Host closed the connection");
                    } catch (IOException e) {
                        if (running) Log.w(TAG, "Connection ended: " + e.getMessage());
                    } finally {
                        synchronized (this) { clientSocket = null; }
                        decoder.endStream();
                        if (running) listener.onDisconnected();
                    }
                }
            } catch (IOException e) {
                if (running) {
                    Log.w(TAG, "Listener failed: " + e.getMessage());
                    try { Thread.sleep(500); } catch (InterruptedException ignored) {}
                }
            } finally {
                synchronized (this) { serverSocket = null; }
            }
        }
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

    private void handleClient(Socket socket, byte[] payload) throws IOException {
        DataInputStream in = new DataInputStream(new BufferedInputStream(socket.getInputStream(), 64 * 1024));
        DataOutputStream out = new DataOutputStream(socket.getOutputStream());
        ReceivedVideo received = new ReceivedVideo();
        boolean configured = false;
        boolean trace = false;
        long lastIdrRequest = -100;
        long lastPresentationUs = 0;
        Thread reporter = null;

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
                    socket.setSoTimeout(0);
                    sendControl(out, READY, 0, null);
                    listener.onConnected(socket.getRemoteSocketAddress().toString());
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
                } else if (type == PING && size == 0) {
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
            }
        } finally {
            if (reporter != null) {
                reporter.interrupt();
                try { socket.close(); } catch (IOException ignored) {}
                try { reporter.join(); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
            }
        }
    }

    private void report(Socket socket, DataOutputStream out, ReceivedVideo received, int telemetryVersion) {
        boolean trace = telemetryVersion == TRACE_V1;
        boolean telemetry = trace || telemetryVersion == TELEMETRY_V1;
        long lastTime = SystemClock.elapsedRealtime();
        long lastReceived = 0, lastBytes = 0, lastDecoded = 0, lastSubmitted = 0;
        try {
            if (telemetry) sendControl(out, CLIENT_INFO, 0, describeDevice());
            while (!socket.isClosed()) {
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
                            .put("decode", decode).put("surfaceGap", surface);
                    Display.Mode mode = displayMode();
                    if (mode != null) {
                        decoder.setPanelRefreshRate(mode.getRefreshRate());
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

    private void sendBytes(DataOutputStream out, int type, long timestampUs, byte[] payload) throws IOException {
        if (payload.length > MAX_CONTROL_BYTES) throw new IOException("Control message too large");
        ByteBuffer message = ByteBuffer.allocate(20 + payload.length);
        message.putInt(MAGIC).put((byte) type).put((byte) 0).putShort((short) 0)
                .putLong(timestampUs).putInt(payload.length).put(payload);
        synchronized (out) {
            out.write(message.array());
            out.flush();
        }
    }
}
