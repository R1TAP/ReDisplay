package com.redisplay.client;

import android.os.SystemClock;
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
import java.util.Locale;

public class NetworkServer implements Runnable {
    private static final String TAG = "ReDisplay_Net";
    public static final int PORT = 27184;
    private static final int MAGIC = 0x52445350; // RDSP
    private static final int VIDEO = 1;
    private static final int CONFIG = 2;
    private static final int PING = 3;
    private static final int PONG = 4;
    private static final int REQUEST_IDR = 5;
    private static final int READY = 6;
    private static final int MAX_VIDEO_BYTES = 4 * 1024 * 1024;

    public interface StatusListener {
        void onConnected(String hostInfo);
        void onDisconnected();
        void onResolutionChanged(int width, int height, int fps);
        void onStatsUpdate(float fps, int bitrateKbps);
    }

    private final VideoDecoder decoder;
    private final StatusListener listener;
    private volatile boolean running;
    private ServerSocket serverSocket;
    private Socket clientSocket;
    private Thread serverThread;

    public NetworkServer(VideoDecoder decoder, StatusListener listener) {
        this.decoder = decoder;
        this.listener = listener;
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

    private void handleClient(Socket socket, byte[] payload) throws IOException {
        DataInputStream in = new DataInputStream(new BufferedInputStream(socket.getInputStream(), 64 * 1024));
        DataOutputStream out = new DataOutputStream(socket.getOutputStream());
        boolean configured = false;
        long lastStatTime = SystemClock.elapsedRealtime();
        long lastIdrRequest = -100;
        long bytes = 0;
        long received = 0;
        long lastRendered = 0;

        while (running) {
            if (in.readInt() != MAGIC) throw new IOException("Invalid packet magic");
            int type = in.readUnsignedByte();
            int flags = in.readUnsignedByte();
            in.readUnsignedShort(); // reserved
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
                sendControl(out, READY, 0);
                lastStatTime = SystemClock.elapsedRealtime();
                listener.onConnected(socket.getRemoteSocketAddress().toString());
            } else if (type == VIDEO && configured && size > 0 && size <= payload.length) {
                in.readFully(payload, 0, size);
                received++;
                long presentationTimeUs = System.nanoTime() / 1000;
                if (!decoder.decode(payload, size, presentationTimeUs, (flags & 1) != 0)) {
                    long now = SystemClock.elapsedRealtime();
                    if (now - lastIdrRequest >= 100) {
                        sendControl(out, REQUEST_IDR, 0);
                        lastIdrRequest = now;
                    }
                }
            } else if (type == PING && size == 0) {
                sendControl(out, PONG, timestampUs);
            } else {
                throw new IOException("Invalid packet type/size: " + type + "/" + size);
            }

            bytes += size + 20;
            long now = SystemClock.elapsedRealtime();
            if (now - lastStatTime >= 1000) {
                double seconds = (now - lastStatTime) / 1000.0;
                long rendered = decoder.getRenderedFrames();
                int kbps = (int) (bytes * 8 / 1000 / seconds);
                float decodedFps = (float) ((rendered - lastRendered) / seconds);
                double[] p95 = decoder.takeTimingP95Ms();
                Log.i(TAG, String.format(Locale.US,
                        "[Android] TCP %.1f FPS | Decoder %.1f FPS | %.1f Mbps | Decode drops %d | Decode P95 %.2f ms | Surface submit gap P95 %.2f ms",
                        received / seconds, decodedFps, kbps / 1000.0, decoder.getDroppedFrames(), p95[0], p95[1]));
                listener.onStatsUpdate(decodedFps, kbps);
                lastRendered = rendered;
                bytes = 0;
                received = 0;
                lastStatTime = now;
            }
        }
    }

    private void sendControl(DataOutputStream out, int type, long timestampUs) throws IOException {
        out.writeInt(MAGIC);
        out.writeByte(type);
        out.writeByte(0);
        out.writeShort(0);
        out.writeLong(timestampUs);
        out.writeInt(0);
        out.flush();
    }
}
