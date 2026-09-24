package com.redisplay.client;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Intent;
import android.os.Binder;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import android.util.Log;

public class DisplayService extends Service {
    private static final String TAG = "ReDisplay_Service";
    private static final String CHANNEL_ID = "redisplay_service_channel";
    private static final int NOTIFICATION_ID = 1001;

    private PowerManager.WakeLock wakeLock;
    private final IBinder binder = new LocalBinder(this);

    public static class LocalBinder extends Binder {
        private final DisplayService service;
        public LocalBinder(DisplayService service) {
            this.service = service;
        }
        public DisplayService getService() {
            return service;
        }
    }

    @Override
    public void onCreate() {
        super.onCreate();
        createNotificationChannel();
        startForeground(NOTIFICATION_ID, buildNotification("ReDisplay 服务已就绪"));

        PowerManager powerManager = (PowerManager) getSystemService(POWER_SERVICE);
        if (powerManager != null) {
            wakeLock = powerManager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "ReDisplay::WakeLock");
            wakeLock.acquire(24 * 60 * 60 * 1000L); // 24 hours
        }
        Log.i(TAG, "DisplayService started in foreground");
    }

    public void updateNotificationText(String text) {
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) {
            manager.notify(NOTIFICATION_ID, buildNotification(text));
        }
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID,
                    "ReDisplay Background Service",
                    NotificationManager.IMPORTANCE_LOW
            );
            channel.setDescription("保持有线副屏低延迟传输链路");
            NotificationManager manager = getSystemService(NotificationManager.class);
            if (manager != null) {
                manager.createNotificationChannel(channel);
            }
        }
    }

    private Notification buildNotification(String text) {
        Notification.Builder builder;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            builder = new Notification.Builder(this, CHANNEL_ID);
        } else {
            builder = new Notification.Builder(this);
        }
        return builder.setContentTitle("ReDisplay 有线超低延迟副屏")
                .setContentText(text)
                .setSmallIcon(android.R.drawable.ic_menu_gallery)
                .setOngoing(true)
                .build();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        return START_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return binder;
    }

    @Override
    public void onDestroy() {
        if (wakeLock != null && wakeLock.isHeld()) {
            wakeLock.release();
        }
        super.onDestroy();
        Log.i(TAG, "DisplayService destroyed");
    }
}
