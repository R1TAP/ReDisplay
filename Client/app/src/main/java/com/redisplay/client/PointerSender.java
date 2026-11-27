package com.redisplay.client;

import android.view.MotionEvent;
import java.io.DataOutputStream;
import java.io.IOException;
import java.util.ArrayDeque;
import java.util.Arrays;

// UI producer, single socket writer. A saturated queue cancels the gesture
// before accepting another DOWN, so a dropped UP can never leave a finger held.
final class PointerSender implements Runnable {
    private final DataOutputStream out;
    private final ArrayDeque<byte[]> queue = new ArrayDeque<>();
    private final boolean[] active = new boolean[32];
    private boolean closed;
    private boolean skipGesture;
    private boolean enabled;
    private long generation;
    private final Runnable onFailure;

    PointerSender(DataOutputStream out, Runnable onFailure, boolean enabled) {
        this.out = out;
        this.onFailure = onFailure;
        this.enabled = enabled;
    }

    synchronized boolean isEnabled() {
        return enabled && !closed;
    }

    synchronized void setMode(boolean enabled, long generation) {
        this.enabled = enabled;
        this.generation = generation;
        queue.clear();
        Arrays.fill(active, false);
        skipGesture = true;
    }
    synchronized void close() {
        closed = true;
        queue.clear();
        notifyAll();
    }
    synchronized void cancel() {
        queue.clear();
        if (isEnabled()) queue.add(new byte[]{5,0,0,0,0,0,0,0,0,0});
        Arrays.fill(active, false);
        skipGesture = true;
        notifyAll();
    }
    private static int axis(float value, int maximum) {
        return Math.round(Math.max(0f, Math.min(1f, value)) * maximum);
    }
    private void sample(MotionEvent e, int i, int history, int phase, int width, int height) {
        if (skipGesture) return;
        int id = e.getPointerId(i);
        int type = e.getToolType(i);
        int tool = type == MotionEvent.TOOL_TYPE_FINGER ? 1 : type == MotionEvent.TOOL_TYPE_STYLUS ? 2 :
                   type == MotionEvent.TOOL_TYPE_ERASER ? 3 : 0;
        if (tool == 0 || id < 0 || id >= active.length) return;
        float x = history < 0 ? e.getX(i) : e.getHistoricalX(i, history);
        float y = history < 0 ? e.getY(i) : e.getHistoricalY(i, history);
        float pressure = history < 0 ? e.getPressure(i) : e.getHistoricalPressure(i, history);
        if (phase == 1) {
            if (x < 0 || x >= width || y < 0 || y >= height) return;
            active[id] = true;
        } else if (!active[id]) return;
        if (phase >= 3) active[id] = false;
        int nx = axis(x / Math.max(1, width-1), 65535), ny = axis(y / Math.max(1, height-1), 65535);
        int p = axis(pressure, 1024);
        byte[] record = {(byte)phase,(byte)tool,(byte)id,0,(byte)(nx>>8),(byte)nx,(byte)(ny>>8),(byte)ny,(byte)(p>>8),(byte)p};
        byte[] last = queue.peekLast();
        if (phase == 2 && tool == 1 && last != null && last[0] == 2 && last[2] == id) queue.removeLast();
        if (queue.size() >= 128) { cancel(); return; }
        queue.addLast(record);
    }
    synchronized void motion(MotionEvent e, int width, int height) {
        if (!isEnabled() || width < 1 || height < 1) return;
        int action = e.getActionMasked(), index = e.getActionIndex();
        if (action == MotionEvent.ACTION_CANCEL || e.getPointerCount() > 10) { cancel(); return; }
        if (action == MotionEvent.ACTION_DOWN) skipGesture = false;
        if (skipGesture) return;
        if (action == MotionEvent.ACTION_MOVE) {
            for (int h = 0; h < e.getHistorySize(); h++)
                for (int i = 0; i < e.getPointerCount(); i++)
                    if (e.getToolType(i) != MotionEvent.TOOL_TYPE_FINGER) sample(e, i, h, 2, width, height);
            for (int i = 0; i < e.getPointerCount(); i++) sample(e, i, -1, 2, width, height);
        } else if (action == MotionEvent.ACTION_DOWN || action == MotionEvent.ACTION_POINTER_DOWN) {
            sample(e, index, -1, 1, width, height);
        } else if (action == MotionEvent.ACTION_UP || action == MotionEvent.ACTION_POINTER_UP) {
            sample(e, index, -1, (e.getFlags() & MotionEvent.FLAG_CANCELED) != 0 ? 4 : 3, width, height);
        }
        notifyAll();
    }
    @Override public void run() {
        try {
            while (true) {
                byte[] record;
                long mode;
                synchronized (this) {
                    while (!closed && queue.isEmpty()) wait();
                    if (closed) return;
                    record = queue.removeFirst();
                    mode = generation;
                }
                NetworkServer.sendBytes(out, NetworkServer.POINTER, mode, record);
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        } catch (IOException e) { onFailure.run(); }
    }
}
