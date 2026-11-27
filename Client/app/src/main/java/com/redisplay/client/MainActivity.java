package com.redisplay.client;

import android.app.Activity;
import android.app.KeyguardManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.ServiceConnection;
import android.content.res.Configuration;
import android.graphics.Color;
import android.graphics.Typeface;
import android.view.Gravity;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.util.Log;
import android.view.Choreographer;
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
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.graphics.drawable.GradientDrawable;
import android.hardware.display.DisplayManager;

public class MainActivity extends Activity implements SurfaceHolder.Callback, NetworkServer.StatusListener {
    private static final String TAG = "ReDisplay_Main";

    private DisplaySurfaceView surfaceView;
    private FrameLayout rootLayout;
    private View waitingPanel;
    private TextView waitingTitle;
    private TextView statsOverlay;
    private KeyguardManager keyguard;
    private PointerSender gestureSender;
    private boolean remoteGesture, resumed, showingStats;
    private float decodedFps;
    private int bitrateKbps;
    private final DisplayManager.DisplayListener displayListener = new DisplayManager.DisplayListener() {
        public void onDisplayAdded(int id) {}
        public void onDisplayRemoved(int id) {}
        public void onDisplayChanged(int id) { if (id == Display.DEFAULT_DISPLAY) updateTiming(); }
    };

    private void updateTiming() {
        Display display = getWindowManager().getDefaultDisplay();
        float hz = display.getRefreshRate();
        decoder.setPanelRefreshRate(hz);
        if (displayTiming != null)
            displayTiming.setEnabled(resumed && hasWindowFocus() && streamFps > 0 && Math.abs(hz - streamFps) <= 0.5f);
    }

    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }

    private PointerSender pointers() {
        return server == null ? null : server.pointers();
    }

    private boolean touchEnabled() {
        PointerSender sender = pointers();
        return sender != null && sender.isEnabled();
    }

    private void cancelInput() {
        if (gestureSender != null) gestureSender.cancel();
        gestureSender = null;
    }

    private GradientDrawable panelBackground(int color, int radius) {
        GradientDrawable panel = new GradientDrawable();
        panel.setColor(color);
        panel.setCornerRadius(dp(radius));
        return panel;
    }

    private TextView statusText(int size, int color) {
        TextView text = new TextView(this);
        text.setTextColor(color);
        text.setTextSize(size);
        return text;
    }

    private void createStatusViews() {
        FrameLayout backdrop = new FrameLayout(this);
        backdrop.setBackground(new GradientDrawable(GradientDrawable.Orientation.TL_BR,
                new int[]{0xff111827, 0xff1d2535, 0xff11141e}));
        rootLayout.addView(backdrop, new FrameLayout.LayoutParams(-1, -1));
        waitingPanel = backdrop;

        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setGravity(Gravity.CENTER_HORIZONTAL);
        card.setPadding(dp(24), dp(26), dp(24), dp(27));
        GradientDrawable cardBackground = panelBackground(0xff232c3d, 24);
        cardBackground.setStroke(dp(1), 0xff39465b);
        card.setBackground(cardBackground);
        FrameLayout.LayoutParams cardParams = new FrameLayout.LayoutParams(-2, -2, Gravity.CENTER);
        cardParams.setMargins(dp(24), dp(24), dp(24), dp(24));
        backdrop.addView(card, cardParams);

        ImageView icon = new ImageView(this);
        icon.setImageResource(R.drawable.redisplay);
        card.addView(icon, new LinearLayout.LayoutParams(dp(54), dp(54)));
        TextView brand = statusText(14, 0xffa7c8fa);
        brand.setText(R.string.app_name);
        brand.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        LinearLayout.LayoutParams brandParams = new LinearLayout.LayoutParams(-2, -2);
        brandParams.topMargin = dp(12);
        card.addView(brand, brandParams);

        waitingTitle = statusText(24, 0xfff2f5fb);
        waitingTitle.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        waitingTitle.setGravity(Gravity.CENTER);
        waitingTitle.setText(R.string.waiting);
        LinearLayout.LayoutParams titleParams = new LinearLayout.LayoutParams(-2, -2);
        titleParams.topMargin = dp(10);
        card.addView(waitingTitle, titleParams);

        TextView detail = statusText(14, 0xffbcc8db);
        detail.setText(R.string.waiting_detail);
        detail.setGravity(Gravity.CENTER);
        detail.setMaxWidth(dp(300));
        LinearLayout.LayoutParams detailParams = new LinearLayout.LayoutParams(-2, -2);
        detailParams.topMargin = dp(8);
        card.addView(detail, detailParams);

        statsOverlay = statusText(13, 0xfff1f5ff);
        statsOverlay.setGravity(Gravity.CENTER);
        statsOverlay.setPadding(dp(16), dp(9), dp(16), dp(9));
        statsOverlay.setBackground(panelBackground(0xf2222939, 18));
        statsOverlay.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
        statsOverlay.setVisibility(View.GONE);
        FrameLayout.LayoutParams overlayParams = new FrameLayout.LayoutParams(-2, -2, Gravity.TOP | Gravity.CENTER_HORIZONTAL);
        overlayParams.setMargins(dp(16), dp(16), dp(16), dp(16));
        rootLayout.addView(statsOverlay, overlayParams);
    }

    private VideoDecoder decoder;
    private NetworkServer server;
    private DisplayService displayService;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private GestureDetector gestureDetector;
    private Runnable hideOverlayRunnable;
    private Intent serviceIntent;
    private boolean serviceBound;
    private boolean destroyed;
    private int streamFps;
    private DisplayTiming displayTiming;

    @android.annotation.TargetApi(Build.VERSION_CODES.TIRAMISU)
    private static final class DisplayTiming implements Choreographer.VsyncCallback {
        private final Choreographer choreographer = Choreographer.getInstance();
        private final VideoDecoder decoder;
        private boolean enabled;

        DisplayTiming(VideoDecoder decoder) {
            this.decoder = decoder;
        }

        void setEnabled(boolean next) {
            if (enabled == next) return;
            enabled = next;
            if (enabled) {
                choreographer.postVsyncCallback(this);
            } else {
                choreographer.removeVsyncCallback(this);
                decoder.setExpectedPresentationTime(0);
            }
        }

        @Override
        public void onVsync(Choreographer.FrameData frame) {
            if (!enabled) return;
            decoder.setExpectedPresentationTime(frame.getPreferredFrameTimeline().getExpectedPresentationTimeNanos());
            choreographer.postVsyncCallback(this);
        }
    }

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
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) displayTiming = new DisplayTiming(decoder);

        // Build UI
        rootLayout = new FrameLayout(this);
        rootLayout.setBackgroundColor(Color.BLACK);

        surfaceView = new DisplaySurfaceView(this);
        surfaceView.getHolder().addCallback(this);
        FrameLayout.LayoutParams svParams = new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT,
                android.view.Gravity.CENTER
        );
        rootLayout.addView(surfaceView, svParams);

        createStatusViews();
        setContentView(rootLayout);
        keyguard = (KeyguardManager) getSystemService(KEYGUARD_SERVICE);
        hideOverlayRunnable = () -> {
            statsOverlay.setVisibility(View.GONE);
            showingStats = false;
        };

        gestureDetector = new GestureDetector(this, new GestureDetector.SimpleOnGestureListener() {
            @Override
            public boolean onDown(MotionEvent e) { return true; }

            @Override
            public boolean onSingleTapConfirmed(MotionEvent e) {
                if (!touchEnabled()) toggleStatsOverlay();
                return true;
            }

            @Override
            public boolean onDoubleTap(MotionEvent e) {
                if (touchEnabled() || streamFps <= 0) return true;
                DisplaySurfaceView.ScaleMode newMode = surfaceView.toggleScaleMode();
                showTemporaryMessage(getString(R.string.scale_mode, scaleLabel(newMode)), 1800);
                return true;
            }
        });

        surfaceView.setOnTouchListener((v, event) -> {
            if (event.getActionMasked() == MotionEvent.ACTION_DOWN) {
                PointerSender sender = pointers();
                remoteGesture = sender != null && sender.isEnabled();
                if (remoteGesture && resumed && hasWindowFocus()) {
                    if (keyguard.isDeviceLocked()) {
                        showTemporaryMessage(getString(R.string.unlock), 1800);
                    } else {
                        gestureSender = sender;
                    }
                }
            }
            if (!remoteGesture) return gestureDetector.onTouchEvent(event);
            if (gestureSender != null) {
                gestureSender.motion(event, v.getWidth(), v.getHeight());
                int action = event.getActionMasked();
                if (action == MotionEvent.ACTION_UP || action == MotionEvent.ACTION_CANCEL) gestureSender = null;
            }
            return true;
        });
        rootLayout.setOnTouchListener((v, event) -> touchEnabled() || gestureDetector.onTouchEvent(event));

        serviceIntent = new Intent(this, DisplayService.class);
        startForegroundService(serviceIntent);
        serviceBound = bindService(serviceIntent, serviceConn, Context.BIND_AUTO_CREATE);
        server = new NetworkServer(decoder, this,
                (DisplayManager) getSystemService(DISPLAY_SERVICE), getIntent().getStringExtra("endpoint"),
                getIntent().getStringExtra("bootstrap"));
        getIntent().removeExtra("bootstrap");
        ((DisplayManager)getSystemService(DISPLAY_SERVICE)).registerDisplayListener(displayListener, handler);
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
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R || streamFps <= 0) return;
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
        } else cancelInput();
        if (decoder != null) updateTiming();
    }

    @Override
    protected void onResume() {
        super.onResume();
        resumed = true;
        updateTiming();
        applyFullscreenImmersive();
        applyStreamRefreshRate();
    }

    @Override
    protected void onPause() {
        resumed = false;
        cancelInput();
        if (displayTiming != null) displayTiming.setEnabled(false);
        super.onPause();
    }

    @Override
    public void onConfigurationChanged(Configuration configuration) {
        super.onConfigurationChanged(configuration);
        cancelInput();
        applyFullscreenImmersive();
        applyStreamRefreshRate();
    }

    private void toggleStatsOverlay() {
        if (streamFps == 0) return;
        if (statsOverlay.getVisibility() == View.VISIBLE) {
            handler.removeCallbacks(hideOverlayRunnable);
            hideOverlayRunnable.run();
            return;
        }
        showTemporaryMessage(statsText(), 3500);
        showingStats = true;
    }

    private String statsText() {
        return getString(R.string.stream_stats, decodedFps, bitrateKbps / 1000.0f, scaleLabel(surfaceView.getScaleMode()));
    }

    private void showTemporaryMessage(String msg, long durationMs) {
        showingStats = false;
        handler.removeCallbacks(hideOverlayRunnable);
        statsOverlay.setText(msg);
        statsOverlay.setVisibility(View.VISIBLE);
        handler.postDelayed(hideOverlayRunnable, durationMs);
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
        cancelInput();
        decoder.setSurface(null);
    }

    @Override
    public void onConnected(boolean inputEnabled) {
        handler.post(() -> {
            if (destroyed) return;
            waitingPanel.setVisibility(View.GONE);
            if (!inputEnabled) showTemporaryMessage(getString(R.string.connected, streamFps), 1800);
            if (displayService != null) {
                displayService.updateNotificationText(getString(R.string.stream_running));
            }
        });
    }

    @Override
    public void onInputModeChanged(boolean enabled) {
        handler.post(() -> {
            if (destroyed) return;
            handler.removeCallbacks(hideOverlayRunnable);
            hideOverlayRunnable.run();
        });
    }

    @Override
    public void onDisconnected() {
        handler.post(() -> {
            if (destroyed) return;
            handler.removeCallbacks(hideOverlayRunnable);
            streamFps = 0;
            cancelInput();
            if (displayTiming != null) displayTiming.setEnabled(false);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                WindowManager.LayoutParams params = getWindow().getAttributes();
                params.preferredDisplayModeId = 0;
                getWindow().setAttributes(params);
                Surface surface = surfaceView.getHolder().getSurface();
                if (surface.isValid()) {
                    try {
                        surface.setFrameRate(0, Surface.FRAME_RATE_COMPATIBILITY_DEFAULT);
                    } catch (RuntimeException e) {
                        Log.w(TAG, "Could not clear the display refresh hint", e);
                    }
                }
            }
            hideOverlayRunnable.run();
            waitingTitle.setText(R.string.disconnected);
            waitingPanel.setVisibility(View.VISIBLE);
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
            updateTiming();
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
            if (destroyed) return;
            decodedFps = fps;
            this.bitrateKbps = bitrateKbps;
            if (showingStats) statsOverlay.setText(statsText());
        });
    }

    @Override
    protected void onDestroy() {
        destroyed = true;
        ((DisplayManager)getSystemService(DISPLAY_SERVICE)).unregisterDisplayListener(displayListener);
        if (displayTiming != null) displayTiming.setEnabled(false);
        handler.removeCallbacksAndMessages(null);
        if (server != null) server.stop();
        if (decoder != null) decoder.release();
        if (serviceBound) unbindService(serviceConn);
        if (serviceIntent != null) stopService(serviceIntent);
        super.onDestroy();
    }
}
