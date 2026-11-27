package com.redisplay.client;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;

// The public launcher opens the waiting screen. Only the ADB entry point
// accepts endpoint and session-key extras.
public class LauncherActivity extends Activity {
    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        startActivity(new Intent(this, MainActivity.class));
        finish();
    }
}
