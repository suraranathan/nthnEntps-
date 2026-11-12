package com.termux.app;

import android.content.Context;

import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;

/** Writes a small private state record that the bundled Jef process can read. */
final class NthnAppState {
    private NthnAppState() {}

    static void record(Context context, String screen) {
        if (!"home".equals(screen) && !"ai".equals(screen) && !"terminal".equals(screen)
            && !"files".equals(screen) && !"settings".equals(screen)) return;
        try {
            File directory = new File(context.getFilesDir(), "nthn-ai/.local/agent");
            if (!directory.isDirectory() && !directory.mkdirs()) return;
            File temporary = new File(directory, "app-state.json.new");
            File target = new File(directory, "app-state.json");
            byte[] data = new JSONObject().put("screen", screen)
                .put("updatedAt", java.time.Instant.now().toString()).toString().getBytes(StandardCharsets.UTF_8);
            try (FileOutputStream output = new FileOutputStream(temporary, false)) {
                output.write(data);
                output.getFD().sync();
            }
            if (!temporary.renameTo(target)) temporary.delete();
        } catch (Exception ignored) {
            // Screen reporting must never prevent navigation.
        }
    }

    static void recordDevice(Context context, JSONObject state) {
        write(context, "device-state.json", state);
    }

    static void recordDashboard(Context context, String value) {
        if (value == null || value.length() > 4096) return;
        try {
            JSONObject input = new JSONObject(value);
            String title = text(input, "title", 200, false);
            String provider = text(input, "provider", 200, true);
            String model = text(input, "model", 500, true);
            String workspace = text(input, "workspace", 500, false);
            int messageCount = input.getInt("messageCount");
            if (messageCount < 0 || messageCount > 100000) return;
            JSONObject dashboard = new JSONObject().put("title", title).put("messageCount", messageCount)
                .put("pendingApproval", input.getBoolean("pendingApproval"))
                .put("provider", provider == null ? JSONObject.NULL : provider)
                .put("model", model == null ? JSONObject.NULL : model).put("workspace", workspace);
            write(context, "app-state.json", new JSONObject().put("screen", "ai")
                .put("updatedAt", java.time.Instant.now().toString()).put("dashboard", dashboard));
        } catch (Exception ignored) { }
    }

    private static String text(JSONObject value, String name, int max, boolean nullable) throws Exception {
        if (nullable && value.isNull(name)) return null;
        String result = value.getString(name);
        if (result.length() > max || result.matches(".*[\\x00-\\x08\\x0b\\x0c\\x0e-\\x1f\\x7f].*")) throw new Exception("invalid text");
        return result;
    }

    private static void write(Context context, String name, JSONObject state) {
        try {
            File directory = new File(context.getFilesDir(), "nthn-ai/.local/agent");
            if (!directory.isDirectory() && !directory.mkdirs()) return;
            File temporary = new File(directory, name + ".new");
            File target = new File(directory, name);
            byte[] data = state.toString().getBytes(StandardCharsets.UTF_8);
            try (FileOutputStream output = new FileOutputStream(temporary, false)) {
                output.write(data);
                output.getFD().sync();
            }
            if (!temporary.renameTo(target)) temporary.delete();
        } catch (Exception ignored) { }
    }
}
