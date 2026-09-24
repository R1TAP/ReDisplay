package com.redisplay.client;

import android.util.Log;
import java.io.BufferedInputStream;
import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.IOException;
import java.net.ServerSocket;
import java.net.Socket;

public class NetworkServer implements Runnable {
    private static final String TAG = "ReDisplay_Net";
    public static final int PORT = 27183;
    public static final int MAGIC = 0x52445350; // "RDSP"

    public interface StatusListener {
        void onConnected(String hostInfo);
        void onDisconnected();
        void onResolutionChanged(int width, int height, int fps);
        void onStatsUpdate(float fps, int bitrateKbps);
    }

    private final VideoDecoder decoder;
    private final StatusListener listener;
    private volatile boolean running = false;
    private ServerSocket serverSocket;
    private Thread serverThread;

    public NetworkServer(VideoDecoder decoder, StatusListener listener) {
        this.decoder = decoder;
        this.listener = listener;
    }

    public synchronized void start() {
        if (!running) {
            running = true;
            serverThread = new Thread(this, "ReDisplay-NetServer");
            serverThread.start();
        }
    }

    public synchronized void stop() {
        running = false;
        if (serverSocket != null) {
            try {
                serverSocket.close();
            } catch (IOException ignored) {}
        }
        if (serverThread != null) {
            serverThread.interrupt();
        }
    }

    @Override
    public void run() {
        Log.i(TAG, "NetworkServer listening on port " + PORT + "...");
        while (running) {
            try {
                serverSocket = new ServerSocket(PORT);
                serverSocket.setReuseAddress(true);

                while (running) {
                    Log.i(TAG, "Waiting for Host connection via ADB tunnel...");
                    if (listener != null) listener.onDisconnected();

                    Socket socket = serverSocket.accept();
                    socket.setTcpNoDelay(true);
                    socket.setReceiveBufferSize(4 * 1024 * 1024); // 4MB buffer for 10Gbps link
                    socket.setSendBufferSize(64 * 1024);

                    Log.i(TAG, "Host connected from: " + socket.getRemoteSocketAddress());
                    if (listener != null) listener.onConnected(socket.getRemoteSocketAddress().toString());

                    handleClient(socket);
                }
            } catch (IOException e) {
                if (running) {
                    Log.w(TAG, "ServerSocket error, restarting: " + e.getMessage());
                    try {
                        Thread.sleep(1000);
                    } catch (InterruptedException ignored) {}
                }
            } finally {
                if (serverSocket != null && !serverSocket.isClosed()) {
                    try {
                        serverSocket.close();
                    } catch (IOException ignored) {}
                }
            }
        }
    }

    private void handleClient(Socket socket) {
        byte[] buffer = new byte[1024 * 1024 * 4]; // 4MB frame buffer
        long lastStatTime = System.currentTimeMillis();
        long totalBytesInSec = 0;
        long rxVideoFrames = 0;

        try (DataInputStream in = new DataInputStream(new BufferedInputStream(socket.getInputStream(), 1024 * 512));
             DataOutputStream out = new DataOutputStream(socket.getOutputStream())) {

            while (running && !socket.isClosed()) {
                // Read 4-byte Magic
                int magic = in.readInt();
                if (magic != MAGIC) {
                    Log.e(TAG, "Invalid magic: " + Integer.toHexString(magic) + ", resyncing...");
                    break;
                }

                // Header fields
                int packetType = in.readUnsignedByte();
                int flags = in.readUnsignedByte();
                in.readShort(); // reserved
                long timestampUs = in.readLong();
                int payloadSize = in.readInt();

                if (payloadSize < 0 || payloadSize > buffer.length) {
                    Log.e(TAG, "Illegal payload size: " + payloadSize);
                    break;
                }

                // Read exact payload
                in.readFully(buffer, 0, payloadSize);
                totalBytesInSec += payloadSize + 20;

                if (packetType == 1) { // Video Frame
                    rxVideoFrames++;
                    boolean isKeyFrame = (flags & 0x01) != 0;
                    decoder.decode(buffer, 0, payloadSize, timestampUs, isKeyFrame);
                } else if (packetType == 2) { // Config / Resolution Change
                    if (payloadSize >= 12) {
                        int w = ((buffer[0] & 0xFF) << 24) | ((buffer[1] & 0xFF) << 16) | ((buffer[2] & 0xFF) << 8) | (buffer[3] & 0xFF);
                        int h = ((buffer[4] & 0xFF) << 24) | ((buffer[5] & 0xFF) << 16) | ((buffer[6] & 0xFF) << 8) | (buffer[7] & 0xFF);
                        int fps = ((buffer[8] & 0xFF) << 24) | ((buffer[9] & 0xFF) << 16) | ((buffer[10] & 0xFF) << 8) | (buffer[11] & 0xFF);
                        Log.i(TAG, "Config received: " + w + "x" + h + " @" + fps + "Hz");
                        decoder.reconfigure(w, h, fps);
                        if (listener != null) listener.onResolutionChanged(w, h, fps);
                    }
                } else if (packetType == 3) { // Ping / Pong for latency measurement
                    out.writeInt(MAGIC);
                    out.writeByte(3); // Pong
                    out.writeByte(0);
                    out.writeShort(0);
                    out.writeLong(timestampUs);
                    out.writeInt(0);
                    out.flush();
                }

                // Periodic stats update
                long now = System.currentTimeMillis();
                if (now - lastStatTime >= 1000) {
                    double elapsedSec = (now - lastStatTime) / 1000.0;
                    int bitrateKbps = (int) (totalBytesInSec * 8 / 1024 / elapsedSec);
                    float rxFps = (float) (rxVideoFrames / elapsedSec);
                    Log.i(TAG, "[Stage 5 Android TCP] Recv: " + String.format(java.util.Locale.US, "%.1f", rxFps) + " FPS (" + String.format(java.util.Locale.US, "%.1f", bitrateKbps / 1000.0f) + " Mbps)");
                    if (listener != null) listener.onStatsUpdate(decoder.getFps(), bitrateKbps);
                    totalBytesInSec = 0;
                    rxVideoFrames = 0;
                    lastStatTime = now;
                }
            }
        } catch (IOException e) {
            Log.i(TAG, "Client disconnected: " + e.getMessage());
        } finally {
            try {
                socket.close();
            } catch (IOException ignored) {}
            if (listener != null) listener.onDisconnected();
        }
    }
}
