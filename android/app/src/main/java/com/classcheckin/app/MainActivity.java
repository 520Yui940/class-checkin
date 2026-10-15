package com.classcheckin.app;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ContentValues;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.provider.MediaStore;
import android.util.Base64;
import android.view.View;
import android.view.WindowManager;
import android.webkit.GeolocationPermissions;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.TextView;
import android.widget.Toast;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;

/**
 * 课堂点名 · 班长端
 * 界面由云端页面承载（同学端同一个页面，扫码即用）；
 * 原生层负责：定位授权、震动、花名册文件选择、导出文件落到「下载」目录。
 */
public class MainActivity extends Activity {

    private static final String SITE_HOST = "class-checkin-41536.app.workbuddy.host";
    private static final String START_URL = "https://" + SITE_HOST + "/";
    private static final int REQ_FILE = 1001;
    private static final int REQ_LOCATION = 1002;

    private WebView web;
    private View errorBox;
    private TextView errorText;
    private ValueCallback<Uri[]> pendingFileCallback;
    private GeolocationPermissions.Callback pendingGeoCallback;
    private String pendingGeoOrigin;
    private boolean loadFailed = false;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        setContentView(R.layout.activity_main);

        web = findViewById(R.id.web);
        errorBox = findViewById(R.id.errorBox);
        errorText = findViewById(R.id.errorText);
        Button retry = findViewById(R.id.retryBtn);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setGeolocationEnabled(true);
        s.setLoadWithOverviewMode(true);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setUserAgentString(s.getUserAgentString() + " ClassCheckinApp/1.0");
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        // 只在 debug 包开 WebView 调试：release 包一旦开启，USB 连上就能读走 WebView 里的
        // localStorage（花名册、历史记录、房间口令）
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);

        web.addJavascriptInterface(new Bridge(), "AndroidBridge");

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                if (u != null && SITE_HOST.equals(u.getHost())) {
                    return false;
                }
                openExternal(u);
                return true;
            }

            @Override
            public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                loadFailed = false;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                if (!loadFailed && url != null && url.startsWith("http")) {
                    errorBox.setVisibility(View.GONE);
                }
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest req, WebResourceError err) {
                if (req != null && req.isForMainFrame()) {
                    loadFailed = true;
                    showError("打不开点名页面，请检查手机流量后重试");
                }
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback callback) {
                pendingGeoCallback = callback;
                pendingGeoOrigin = origin;
                if (checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED) {
                    callback.invoke(origin, true, false);
                    pendingGeoCallback = null;
                } else {
                    try {
                        requestPermissions(
                                new String[]{Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION},
                                REQ_LOCATION);
                    } catch (Throwable t) {
                        callback.invoke(origin, false, false);
                        pendingGeoCallback = null;
                    }
                }
            }

            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> cb, FileChooserParams params) {
                if (pendingFileCallback != null) {
                    pendingFileCallback.onReceiveValue(null);
                }
                pendingFileCallback = cb;
                Intent i = new Intent(Intent.ACTION_GET_CONTENT);
                i.addCategory(Intent.CATEGORY_OPENABLE);
                i.setType("*/*");
                try {
                    startActivityForResult(Intent.createChooser(i, "选择花名册文件"), REQ_FILE);
                    return true;
                } catch (Throwable t) {
                    pendingFileCallback = null;
                    return false;
                }
            }
        });

        retry.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                errorBox.setVisibility(View.GONE);
                web.loadUrl(START_URL);
            }
        });

        if (savedInstanceState == null) {
            web.loadUrl(START_URL);
        } else {
            web.restoreState(savedInstanceState);
        }
    }

    private void showError(String msg) {
        errorText.setText(msg);
        errorBox.setVisibility(View.VISIBLE);
    }

    private void openExternal(Uri u) {
        if (u == null) {
            return;
        }
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, u));
        } catch (Throwable ignored) {
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQ_FILE) {
            if (pendingFileCallback != null) {
                pendingFileCallback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data));
                pendingFileCallback = null;
            }
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        if (requestCode == REQ_LOCATION) {
            boolean ok = grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED;
            if (pendingGeoCallback != null) {
                pendingGeoCallback.invoke(pendingGeoOrigin, ok, false);
                pendingGeoCallback = null;
            }
            if (!ok) {
                toastMsg("没给定位权限，本次点名不做距离校验");
            }
            return;
        }
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
    }

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) {
            web.goBack();
            return;
        }
        super.onBackPressed();
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        if (web != null) {
            web.saveState(outState);
        }
    }

    private void toastMsg(final String msg) {
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                Toast.makeText(MainActivity.this, msg, Toast.LENGTH_LONG).show();
            }
        });
    }

    private class Bridge {

        private boolean trusted() {
            String u = web == null ? null : web.getUrl();
            return u != null && u.startsWith("https://" + SITE_HOST);
        }

        @JavascriptInterface
        public void vibrate(int ms) {
            if (!trusted()) {
                return;
            }
            int d = Math.max(10, Math.min(ms, 200));
            try {
                Vibrator v = (Vibrator) getSystemService(VIBRATOR_SERVICE);
                if (v == null || !v.hasVibrator()) {
                    return;
                }
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    v.vibrate(VibrationEffect.createOneShot(d, VibrationEffect.DEFAULT_AMPLITUDE));
                } else {
                    v.vibrate(d);
                }
            } catch (Throwable ignored) {
            }
        }

        @JavascriptInterface
        public void saveFile(String name, String base64) {
            if (!trusted()) {
                return;
            }
            final String fileName = safeName(name);
            try {
                byte[] data = Base64.decode(base64, Base64.DEFAULT);
                String where = writeToDownloads(fileName, data);
                if (where == null) {
                    toastMsg("保存失败，请重试");
                } else {
                    toastMsg("已保存：" + where);
                }
            } catch (Throwable t) {
                toastMsg("保存失败：" + (t.getMessage() == null ? "未知错误" : t.getMessage()));
            }
        }
    }

    private static String safeName(String name) {
        String n = name == null ? "" : name.trim();
        if (n.length() == 0) {
            n = "点名导出";
        }
        n = n.replaceAll("[\\\\/:*?\"<>|]", "_");
        if (n.length() > 60) {
            n = n.substring(0, 60);
        }
        String lower = n.toLowerCase();
        if (!(lower.endsWith(".xlsx") || lower.endsWith(".xls") || lower.endsWith(".csv") || lower.endsWith(".txt"))) {
            n = n + ".xlsx";
        }
        return n;
    }

    private static String mimeOf(String n) {
        String lower = n.toLowerCase();
        if (lower.endsWith(".csv")) {
            return "text/csv";
        }
        if (lower.endsWith(".txt")) {
            return "text/plain";
        }
        if (lower.endsWith(".xls")) {
            return "application/vnd.ms-excel";
        }
        return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    }

    private String writeToDownloads(String fileName, byte[] data) {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                ContentValues cv = new ContentValues();
                cv.put(MediaStore.Downloads.DISPLAY_NAME, fileName);
                cv.put(MediaStore.Downloads.MIME_TYPE, mimeOf(fileName));
                cv.put(MediaStore.Downloads.IS_PENDING, 1);
                Uri uri = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, cv);
                if (uri == null) {
                    return null;
                }
                OutputStream os = getContentResolver().openOutputStream(uri);
                if (os == null) {
                    return null;
                }
                os.write(data);
                os.flush();
                os.close();
                cv.clear();
                cv.put(MediaStore.Downloads.IS_PENDING, 0);
                getContentResolver().update(uri, cv, null, null);
                return "下载/" + fileName;
            }
            File dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
            if (!dir.exists() && !dir.mkdirs()) {
                return null;
            }
            File out = new File(dir, fileName);
            FileOutputStream fos = new FileOutputStream(out);
            fos.write(data);
            fos.flush();
            fos.close();
            return "下载/" + fileName;
        } catch (Throwable t) {
            return null;
        }
    }
}
