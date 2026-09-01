package com.droidscope.companion;

import android.content.Context;
import android.content.SharedPreferences;
import org.json.JSONObject;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

final class ApiClient {
    private static final String PREFS = "droidscope";
    private ApiClient() {}

    static JSONObject post(Context context, String route, JSONObject body, boolean authenticated) throws Exception {
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String base = prefs.getString("serverUrl", BuildConfig.DEFAULT_SERVER_URL).replaceAll("/+$", "");
        if (!base.startsWith("https://") && !base.startsWith("http://10.0.2.2")) throw new IllegalArgumentException("An HTTPS dashboard address is required.");
        HttpURLConnection connection = (HttpURLConnection) new URL(base + route).openConnection();
        connection.setRequestMethod("POST");
        connection.setConnectTimeout(12000);
        connection.setReadTimeout(15000);
        connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
        if (authenticated) {
            String id = prefs.getString("deviceId", "");
            String secret = prefs.getString("deviceSecret", "");
            connection.setRequestProperty("Authorization", "Device " + id + ":" + secret);
        }
        connection.setDoOutput(true);
        byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
        try (OutputStream output = connection.getOutputStream()) { output.write(bytes); }
        int status = connection.getResponseCode();
        BufferedReader reader = new BufferedReader(new InputStreamReader(status < 400 ? connection.getInputStream() : connection.getErrorStream(), StandardCharsets.UTF_8));
        StringBuilder text = new StringBuilder(); for (String line; (line = reader.readLine()) != null;) text.append(line);
        JSONObject result = text.length() == 0 ? new JSONObject() : new JSONObject(text.toString());
        if (status >= 400) throw new IllegalStateException(result.optString("error", "Dashboard request failed."));
        return result;
    }

    static boolean isEnrolled(Context context) {
        return !context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("deviceSecret", "").isEmpty();
    }
}
