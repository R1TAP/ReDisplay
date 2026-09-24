package com.redisplay.client;

import android.content.Context;
import android.util.AttributeSet;
import android.view.SurfaceView;

public class DisplaySurfaceView extends SurfaceView {
    public enum ScaleMode {
        FIT,     // Keep aspect ratio with letterbox/pillarbox
        FILL,    // Crop to fill screen completely
        STRETCH  // Stretch to entire screen
    }

    private ScaleMode scaleMode = ScaleMode.FIT;
    private int videoWidth = 2800;
    private int videoHeight = 1752;

    public DisplaySurfaceView(Context context) {
        super(context);
    }

    public DisplaySurfaceView(Context context, AttributeSet attrs) {
        super(context, attrs);
    }

    public void setVideoSize(int width, int height) {
        if (width > 0 && height > 0) {
            this.videoWidth = width;
            this.videoHeight = height;
            post(this::requestLayout);
        }
    }

    public void setScaleMode(ScaleMode mode) {
        this.scaleMode = mode;
        post(this::requestLayout);
    }

    public ScaleMode getScaleMode() {
        return scaleMode;
    }

    public ScaleMode toggleScaleMode() {
        if (scaleMode == ScaleMode.FIT) {
            scaleMode = ScaleMode.FILL;
        } else if (scaleMode == ScaleMode.FILL) {
            scaleMode = ScaleMode.STRETCH;
        } else {
            scaleMode = ScaleMode.FIT;
        }
        post(this::requestLayout);
        return scaleMode;
    }

    @Override
    protected void onMeasure(int widthMeasureSpec, int heightMeasureSpec) {
        int width = getDefaultSize(videoWidth, widthMeasureSpec);
        int height = getDefaultSize(videoHeight, heightMeasureSpec);

        if (videoWidth > 0 && videoHeight > 0 && scaleMode != ScaleMode.STRETCH) {
            float viewRatio = (float) width / height;
            float videoRatio = (float) videoWidth / videoHeight;

            if (scaleMode == ScaleMode.FIT) {
                if (viewRatio > videoRatio) {
                    width = (int) (height * videoRatio);
                } else {
                    height = (int) (width / videoRatio);
                }
            } else if (scaleMode == ScaleMode.FILL) {
                if (viewRatio > videoRatio) {
                    height = (int) (width / videoRatio);
                } else {
                    width = (int) (height * videoRatio);
                }
            }
        }
        setMeasuredDimension(width, height);
    }
}
