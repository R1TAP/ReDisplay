package com.redisplay.client;

import android.app.Activity;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.ServiceConnection;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.util.Log;
import android.view.Display;
import android.view.GestureDetector;
import android.view.MotionEvent;
import android.view.Surface;
import android.view.SurfaceHolder;
import android.view.View;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.widget.FrameLayout;
import android.widget.TextView;

public class MainActivity extends Activity implements SurfaceHolder.Callback, NetworkServer.StatusListener {
    private static final String TAG = "ReDisplay_Main";

    private DisplaySurfaceView surfaceView;
    private TextView statsOverlay;
    private VideoDecoder decoder;
    private NetworkServer server;
    private DisplayService displayService;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private GestureDetector gestureDetector;
    private Runnable hideOverlayRunnable;
    private Intent serviceIntent;
    private boolean serviceBound;
    private boolean destroyed;
    private int streamFps = 120;

    private final ServiceConnection serviceConn = new ServiceConnection() {
        @Override
        public void onServiceConnected(ComponentName name, IBinder binder) {
            displayService = ((DisplayService.LocalBinder) binder).getService();
        }

        @Override
        public void onServiceDisconnected(ComponentName name) {
            displayService = null;
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // Keep screen on and show above lockscreen
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true);
            setTurnScreenOn(true);
        } else {
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON);
        }

        // Support cutout to draw behind camera hole
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            WindowManager.LayoutParams lp = getWindow().getAttributes();
            lp.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS;
            getWindow().setAttributes(lp);
        }

        decoder = new VideoDecoder();

        // Build UI
        FrameLayout rootLayout = new FrameLayout(this);
        rootLayout.setBackgroundColor(Color.BLACK);

        surfaceView = new DisplaySurfaceView(this);
        surfaceView.getHolder().addCallback(this);
        FrameLayout.LayoutParams svParams = new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT,
                android.view.Gravity.CENTER
        );
        rootLayout.addView(surfaceView, svParams);

        // Subtle stats overlay
        statsOverlay = new TextView(this);
        statsOverlay.setTextColor(Color.GREEN);
        statsOverlay.setTextSize(13);
        statsOverlay.setPadding(30, 30, 30, 30);
        statsOverlay.setBackgroundColor(Color.parseColor("#80000000"));
        statsOverlay.setText(getString(R.string.waiting, NetworkServer.PORT));
        statsOverlay.setVisibility(View.VISIBLE);
        FrameLayout.LayoutParams overlayParams = new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.WRAP_CONTENT,
                FrameLayout.LayoutParams.WRAP_CONTENT
        );
        rootLayout.addView(statsOverlay, overlayParams);

        setContentView(rootLayout);

        hideOverlayRunnable = () -> statsOverlay.setVisibility(View.GONE);
        handler.postDelayed(hideOverlayRunnable, 4000);

        gestureDetector = new GestureDetector(this, new GestureDetector.SimpleOnGestureListener() {
            @Override
            public boolean onDown(MotionEvent e) { return true; }

            @Override
            public boolean onSingleTapConfirmed(MotionEvent e) {
                toggleStatsOverlay();
                return true;
            }

            @Override
            public boolean onDoubleTap(MotionEvent e) {
                DisplaySurfaceView.ScaleMode newMode = surfaceView.toggleScaleMode();
                showTemporaryMessage(getString(R.string.scale_mode, scaleLabel(newMode)));
                return true;
            }
        });

        rootLayout.setOnTouchListener((v, event) -> gestureDetector.onTouchEvent(event));

        serviceIntent = new Intent(this, DisplayService.class);
        startForegroundService(serviceIntent);
        serviceBound = bindService(serviceIntent, serviceConn, Context.BIND_AUTO_CREATE);
        server = new NetworkServer(decoder, this);
        server.start();
    }

    private String scaleLabel(DisplaySurfaceView.ScaleMode mode) {
        switch (mode) {
            case FIT: return getString(R.string.scale_fit);
            case FILL: return getString(R.string.scale_fill);
            default: return getString(R.string.scale_stretch);
        }
    }

    private void applyStreamRefreshRate() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return;
        Display display = getDisplay();
        if (display == null) return;

        Display.Mode current = display.getMode();
        Display.Mode best = current;
        double bestScore = Double.MAX_VALUE;
        for (Display.Mode mode : display.getSupportedModes()) {
            if (mode.getPhysicalWidth() != current.getPhysicalWidth() ||
                    mode.getPhysicalHeight() != current.getPhysicalHeight()) continue;
            float refresh = mode.getRefreshRate();
            double score = Math.abs(refresh - streamFps);
            if (refresh < streamFps - 0.5f) score += 1000;
            if (score < bestScore) {
                best = mode;
                bestScore = score;
            }
        }

        WindowManager.LayoutParams params = getWindow().getAttributes();
        params.preferredDisplayModeId = best.getModeId();
        getWindow().setAttributes(params);
        Surface surface = surfaceView.getHolder().getSurface();
        if (surface.isValid()) {
            try {
                surface.setFrameRate(Math.min(streamFps, best.getRefreshRate()), Surface.FRAME_RATE_COMPATIBILITY_DEFAULT);
            } catch (RuntimeException e) {
                Log.w(TAG, "Display refresh hint unavailable", e);
            }
        }
        Log.i(TAG, "Refresh request: stream " + streamFps + " Hz, panel mode " + best.getRefreshRate() + " Hz");
    }

    private void applyFullscreenImmersive() {
        Window window = getWindow();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            WindowInsetsController controller = window.getInsetsController();
            if (controller != null) {
                controller.hide(WindowInsets.Type.statusBars() | WindowInsets.Type.navigationBars());
                controller.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            }
        } else {
            window.getDecorView().setSystemUiVisibility(
                    View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                            | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                            | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                            | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                            | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                            | View.SYSTEM_UI_FLAG_FULLSCREEN
            );
        }
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) {
            applyFullscreenImmersive();
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        applyFullscreenImmersive();
    }

    private void toggleStatsOverlay() {
        handler.removeCallbacks(hideOverlayRunnable);
        if (statsOverlay.getVisibility() == View.VISIBLE) {
            statsOverlay.setVisibility(View.GONE);
        } else {
            statsOverlay.setVisibility(View.VISIBLE);
            handler.postDelayed(hideOverlayRunnable, 4000);
        }
    }

    private void showTemporaryMessage(String msg) {
        handler.removeCallbacks(hideOverlayRunnable);
        statsOverlay.setText(msg);
        statsOverlay.setVisibility(View.VISIBLE);
        handler.postDelayed(hideOverlayRunnable, 3000);
    }

    @Override
    public void surfaceCreated(SurfaceHolder holder) {
        Log.i(TAG, "Surface created, attaching to decoder");
        applyStreamRefreshRate();
        decoder.setSurface(holder.getSurface());
    }

    @Override
    public void surfaceChanged(SurfaceHolder holder, int format, int width, int height) {
        Log.i(TAG, "Surface changed: " + width + "x" + height);
    }

    @Override
    public void surfaceDestroyed(SurfaceHolder holder) {
        Log.i(TAG, "Surface destroyed, detaching from decoder");
        decoder.setSurface(null);
    }

    @Override
    public void onConnected(String hostInfo) {
        handler.post(() -> {
            if (destroyed) return;
            statsOverlay.setText(getString(R.string.connected, hostInfo, streamFps));
            statsOverlay.setVisibility(View.VISIBLE);
            handler.removeCallbacks(hideOverlayRunnable);
            handler.postDelayed(hideOverlayRunnable, 2500);
            if (displayService != null) {
                displayService.updateNotificationText(getString(R.string.stream_running, hostInfo));
            }
        });
    }

    @Override
    public void onDisconnected() {
        handler.post(() -> {
            if (destroyed) return;
            handler.removeCallbacks(hideOverlayRunnable);
            statsOverlay.setText(getString(R.string.disconnected, NetworkServer.PORT));
            statsOverlay.setVisibility(View.VISIBLE);
            if (displayService != null) {
                displayService.updateNotificationText(getString(R.string.waiting_notification));
            }
        });
    }

    @Override
    public void onResolutionChanged(int width, int height, int fps) {
        handler.post(() -> {
            if (destroyed) return;
            streamFps = fps;
            applyStreamRefreshRate();
            surfaceView.setVideoSize(width, height);
            if (height > width) {
                setRequestedOrientation(android.content.pm.ActivityInfo.SCREEN_ORIENTATION_SENSOR_PORTRAIT);
            } else {
                setRequestedOrientation(android.content.pm.ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE);
            }
        });
    }

    @Override
    public void onStatsUpdate(float fps, int bitrateKbps) {
        handler.post(() -> {
            if (!destroyed && statsOverlay.getVisibility() == View.VISIBLE) {
                statsOverlay.setText(getString(R.string.stream_stats,
                        fps, bitrateKbps / 1000.0f, scaleLabel(surfaceView.getScaleMode())));
            }
        });
    }

    @Override
    protected void onDestroy() {
        destroyed = true;
        handler.removeCallbacksAndMessages(null);
        if (server != null) server.stop();
        if (decoder != null) decoder.release();
        if (serviceBound) unbindService(serviceConn);
        if (serviceIntent != null) stopService(serviceIntent);
        super.onDestroy();
    }
}
