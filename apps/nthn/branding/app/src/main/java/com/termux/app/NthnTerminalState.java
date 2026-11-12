package com.termux.app;

import android.content.Context;

import com.termux.terminal.TerminalSession;

import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.time.Instant;

/** Publishes a bounded read-only view of the visible native terminal for an approved Jef tool call. */
final class NthnTerminalState {
    private static final int MAX_TRANSCRIPT = 16_384;
    private static long lastWriteAt;

    private NthnTerminalState() {}

    static synchronized void record(Context context, TerminalSession session) {
        if (session == null || session.getEmulator() == null) return;
        long now = System.currentTimeMillis();
        if (now - lastWriteAt < 250) return;
        lastWriteAt = now;
        try {
            String transcript = session.getEmulator().getScreen().getTranscriptText();
            if (transcript.length() > MAX_TRANSCRIPT) transcript = transcript.substring(transcript.length() - MAX_TRANSCRIPT);
            JSONObject state = new JSONObject()
                .put("title", session.getTitle() == null ? "terminal" : session.getTitle())
                .put("cwd", session.getCwd() == null ? JSONObject.NULL : session.getCwd())
                .put("running", session.isRunning())
                .put("transcript", transcript)
                .put("observedAt", Instant.now().toString());
            File directory = new File(context.getFilesDir(), "nthn-ai/.local/agent");
            if (!directory.isDirectory() && !directory.mkdirs()) return;
            File temporary = new File(directory, "terminal-state.json.new");
            File target = new File(directory, "terminal-state.json");
            try (FileOutputStream output = new FileOutputStream(temporary, false)) {
                output.write(state.toString().getBytes(StandardCharsets.UTF_8));
                output.getFD().sync();
            }
            if (!temporary.renameTo(target)) temporary.delete();
        } catch (Exception ignored) {
            // Terminal reporting must never interrupt the terminal session.
        }
    }
}
