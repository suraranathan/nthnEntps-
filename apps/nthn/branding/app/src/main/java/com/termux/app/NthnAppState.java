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
