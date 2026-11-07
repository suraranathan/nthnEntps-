package com.termux.app;

import android.app.AlertDialog;
import android.content.Intent;
import android.graphics.Typeface;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import androidx.annotation.Nullable;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.content.ContextCompat;

import com.termux.R;
import com.termux.app.activities.SettingsActivity;

import org.json.JSONObject;

import java.io.File;
import java.io.IOException;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Native launch dashboard for the existing NTHN terminal and Linux environment. */
public final class NthnActivity extends AppCompatActivity {
    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private final Handler main = new Handler(Looper.getMainLooper());
    private FrameLayout content;
    private TextView title;
    private NthnBackend backend;
    private File currentDirectory;
    private String screen = NthnNavigation.HOME;
    private boolean destroyed;

    @Override public void onCreate(@Nullable Bundle state) {
        NthnTheme.apply(this);
        super.onCreate(state);
        setContentView(R.layout.activity_nthn);
        content = findViewById(R.id.nthn_content);
        title = findViewById(R.id.nthn_title);
        try {
            backend = new NthnBackend(this);
            currentDirectory = backend.home();
        } catch (IOException error) {
            Toast.makeText(this, error.getMessage(), Toast.LENGTH_LONG).show();
        }
        show(getIntent().getStringExtra(NthnNavigation.EXTRA_SCREEN));
    }

    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        show(intent.getStringExtra(NthnNavigation.EXTRA_SCREEN));
    }

    @Override protected void onDestroy() {
        destroyed = true;
        if (backend != null) backend.stop();
        executor.shutdownNow();
        super.onDestroy();
    }

    private void show(String requested) {
        screen = requested == null ? NthnNavigation.HOME : requested;
        if (!screen.equals(NthnNavigation.HOME) && !screen.equals(NthnNavigation.AI)
            && !screen.equals(NthnNavigation.FILES) && !screen.equals(NthnNavigation.SETTINGS))
            screen = NthnNavigation.HOME;
        content.removeAllViews();
        int selected;
        if (screen.equals(NthnNavigation.AI)) {
            title.setText("AI"); selected = R.id.nav_ai; showAi();
        } else if (screen.equals(NthnNavigation.FILES)) {
            title.setText("Files"); selected = R.id.nav_files; showFiles();
        } else if (screen.equals(NthnNavigation.SETTINGS)) {
            title.setText("Settings"); selected = R.id.nav_settings; showSettings();
        } else {
            title.setText("NTHN"); selected = R.id.nav_home; showHome();
        }
        NthnNavigation.attach(this, selected);
    }

    private LinearLayout page() {
        LinearLayout body = new LinearLayout(this);
        body.setOrientation(LinearLayout.VERTICAL);
        body.setPadding(dp(24), dp(14), dp(24), dp(32));
        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        scroll.addView(body, new ScrollView.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        content.addView(scroll, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        return body;
    }

    private TextView heading(String value) {
        TextView view = text(value, 24, true, R.color.nthn_text);
        view.setPadding(0, 0, 0, dp(8));
        return view;
    }

    private TextView label(String value) {
        TextView view = text(value.toUpperCase(Locale.ROOT), 11, true, R.color.nthn_muted);
        view.setLetterSpacing(.12f);
        view.setPadding(0, dp(24), 0, dp(8));
        return view;
    }

    private TextView text(String value, int sp, boolean bold, int color) {
        TextView view = new TextView(this);
        view.setText(value);
        view.setTextSize(sp);
        view.setTextColor(ContextCompat.getColor(this, color));
        view.setTypeface(Typeface.create("sans", bold ? Typeface.BOLD : Typeface.NORMAL));
        view.setLineSpacing(0, 1.15f);
        return view;
    }

    private TextView row(String value, View.OnClickListener listener) {
        TextView view = text(value, 16, false, R.color.nthn_text);
        view.setGravity(Gravity.CENTER_VERTICAL);
        view.setMinHeight(dp(54));
        view.setPadding(dp(2), 0, dp(2), 0);
        view.setCompoundDrawablesWithIntrinsicBounds(0, 0, R.drawable.ic_nthn_chevron, 0);
        view.setCompoundDrawablePadding(dp(12));
        view.setBackgroundResource(resolveSelectableBackground());
        view.setOnClickListener(listener);
        return view;
    }

    private Button button(String value, View.OnClickListener listener) {
        Button button = new Button(this);
        button.setText(value);
        button.setAllCaps(false);
        button.setTextSize(14);
        button.setOnClickListener(listener);
        return button;
    }

    private void showHome() {
        final LinearLayout body = page();
        body.addView(heading("Your Linux workspace"));
        body.addView(text("Local tools, files and AI in one place.", 15, false, R.color.nthn_muted));
        body.addView(label("Environment"));
        final TextView status = text("Checking…", 16, false, R.color.nthn_text);
        body.addView(status);
        body.addView(label("Open"));
        body.addView(row("Terminal", v -> NthnNavigation.open(this, "terminal")));
        body.addView(row("AI provider", v -> show(NthnNavigation.AI)));
        body.addView(row("Files", v -> show(NthnNavigation.FILES)));
        if (backend == null) { status.setText("Unavailable"); return; }
        runTask(() -> backend.environmentStatus(), value -> {
            NthnBackend.EnvironmentStatus environment = (NthnBackend.EnvironmentStatus) value;
            String state = environment.ready ? "Ready" : "Setup required";
            String node = environment.nodeReady ? "Node available" : "Node unavailable";
            status.setText(state + "  ·  " + node + "\n" + formatBytes(environment.freeBytes) + " free");
        }, status);
    }

    private void showAi() {
        final LinearLayout body = page();
        body.addView(heading("OpenRouter"));
        final TextView status = text("Checking connection…", 15, false, R.color.nthn_muted);
        body.addView(status);

        LinearLayout actions = new LinearLayout(this);
        actions.setOrientation(LinearLayout.HORIZONTAL);
        Button configure = button("Configure key", v -> configureKey(status));
        Button test = button("Test", v -> runAi("test", null, status, null));
        actions.addView(configure, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
        actions.addView(test, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
        body.addView(actions);

        body.addView(label("Text models"));
        final LinearLayout models = new LinearLayout(this);
        models.setOrientation(LinearLayout.VERTICAL);
        body.addView(button("Refresh models", v -> loadModels(status, models)));
        body.addView(models);
        body.addView(label("Credentials"));
        body.addView(row("Remove API key", v -> confirmClearKey(status)));
        runAi("status", null, status, null);
    }

    private void configureKey(final TextView status) {
        final EditText key = new EditText(this);
        key.setSingleLine(true);
        key.setHint("OpenRouter API key");
        key.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        int spacing = dp(20);
        FrameLayout frame = new FrameLayout(this);
        frame.setPadding(spacing, 0, spacing, 0);
        frame.addView(key);
        new AlertDialog.Builder(this)
            .setTitle("Configure OpenRouter")
            .setMessage("The key is sent directly to the encrypted private vault.")
            .setView(frame)
            .setNegativeButton("Cancel", null)
            .setPositiveButton("Save and test", (dialog, which) -> {
                char[] secret = key.getText().toString().trim().toCharArray();
                key.setText("");
                if (secret.length == 0) { toast("Enter an API key"); return; }
                runAi("configure-stdin", secret, status, null);
            }).show();
    }

    private void loadModels(final TextView status, final LinearLayout models) {
        models.removeAllViews();
        status.setText("Loading models…");
        runAi("models", null, status, result -> {
            models.removeAllViews();
            String[] lines = result.output.split("\\n");
            int count = 0;
            for (String line : lines) {
                String[] fields = line.split("\\t", 3);
                if (fields.length < 2) continue;
                final String modelId = fields[0];
                TextView model = row(fields[1] + "\n" + modelId, v -> selectModel(modelId, status));
                model.setTextSize(14);
                models.addView(model);
                count++;
            }
            status.setText(count > 0 ? count + " text models available" : "No text models available");
        });
    }

    private void selectModel(final String modelId, final TextView status) {
        status.setText("Testing " + modelId + "…");
        runAi("select:" + modelId, null, status, result -> {
            status.setText("Connected  ·  " + modelId + " selected and verified");
        });
    }

    private void confirmClearKey(final TextView status) {
        new AlertDialog.Builder(this).setTitle("Remove API key?")
            .setMessage("OpenRouter will be disconnected from this app.")
            .setNegativeButton("Cancel", null)
            .setPositiveButton("Remove", (dialog, which) -> runAi("clear-key", null, status, null)).show();
    }

    private interface AiSuccess { void accept(NthnBackend.CommandResult result); }

    private void runAi(final String commandSpec, final char[] secret, final TextView status, final AiSuccess success) {
        if (backend == null) { status.setText("AI service unavailable"); return; }
        final String command;
        final String argument;
        int separator = commandSpec.indexOf(':');
        if (separator > 0) { command = commandSpec.substring(0, separator); argument = commandSpec.substring(separator + 1); }
        else { command = commandSpec; argument = null; }
        executor.execute(() -> {
            try {
                NthnBackend.CommandResult result = backend.ai(command, argument, secret);
                main.post(() -> {
                    if (destroyed || !screen.equals(NthnNavigation.AI)) return;
                    if (!result.ok()) status.setText(aiMessage(result.output));
                    else if (success != null) success.accept(result);
                    else status.setText(aiMessage(result.output));
                });
            } catch (Exception error) {
                if (secret != null) java.util.Arrays.fill(secret, '\0');
                main.post(() -> { if (!destroyed) status.setText(message(error)); });
            }
        });
    }

    private String aiMessage(String output) {
        try {
            JSONObject value = new JSONObject(output);
            if (value.has("message")) return value.getString("message");
            String connection = value.optString("connection", "Not connected");
            String credentials = value.optString("credentials", "");
            String selected = value.optString("selectedModel", "");
            String inference = value.optString("inference", "");
            String result = connection;
            if (!credentials.isEmpty()) result += "  ·  credentials " + credentials;
            if (!selected.isEmpty() && !"null".equals(selected)) result += "\nSelected: " + selected;
            if (!inference.isEmpty() && !"null".equals(inference)) result += "  ·  inference " + inference;
            return result;
        } catch (Exception ignored) {
            return output.isEmpty() ? "Done" : output;
        }
    }

    private void showFiles() {
        final LinearLayout body = page();
        if (backend == null) { body.addView(text("Files unavailable", 16, false, R.color.nthn_text)); return; }
        try { currentDirectory = backend.confine(currentDirectory == null ? backend.home() : currentDirectory); }
        catch (IOException error) { currentDirectory = backend.home(); }
        String relative = currentDirectory.equals(backend.home()) ? "~" : "~/" + backend.home().toURI().relativize(currentDirectory.toURI()).getPath();
        body.addView(heading(relative));
        LinearLayout actions = new LinearLayout(this);
        actions.setOrientation(LinearLayout.HORIZONTAL);
        actions.addView(button("New file", v -> createEntry(false)), new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
        actions.addView(button("New folder", v -> createEntry(true)), new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
        body.addView(actions);
        if (!currentDirectory.equals(backend.home())) body.addView(row("..", v -> { currentDirectory = currentDirectory.getParentFile(); showFiles(); }));
        try {
            List<File> files = backend.listFiles(currentDirectory);
            if (files.isEmpty()) body.addView(text("This folder is empty.", 15, false, R.color.nthn_muted));
            for (final File file : files) {
                TextView item = row((file.isDirectory() ? "▣  " : "") + file.getName(), v -> openFile(file));
                item.setOnLongClickListener(v -> { manageFile(file); return true; });
                body.addView(item);
            }
        } catch (IOException error) { body.addView(text(error.getMessage(), 15, false, R.color.nthn_muted)); }
    }

    private void createEntry(final boolean folder) {
        prompt(folder ? "New folder" : "New file", "Name", "", name -> {
            try { backend.createFile(currentDirectory, name, folder); showFiles(); }
            catch (IOException error) { toast(error.getMessage()); }
        });
    }

    private void openFile(File file) {
        if (file.isDirectory()) { currentDirectory = file; showFiles(); return; }
        try {
            final String content = backend.readText(file);
            EditText editor = new EditText(this);
            editor.setGravity(Gravity.TOP | Gravity.START);
            editor.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_MULTI_LINE | InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS);
            editor.setText(content);
            editor.setMinLines(12);
            new AlertDialog.Builder(this).setTitle(file.getName()).setView(editor)
                .setNegativeButton("Cancel", null)
                .setPositiveButton("Save", (dialog, which) -> {
                    try { backend.writeText(file, editor.getText().toString()); toast("Saved"); }
                    catch (IOException error) { toast(error.getMessage()); }
                }).show();
        } catch (IOException error) { toast(error.getMessage()); }
    }

    private void manageFile(final File file) {
        new AlertDialog.Builder(this).setTitle(file.getName())
            .setItems(new String[] { "Rename", "Delete" }, (dialog, which) -> {
                if (which == 0) prompt("Rename", "Name", file.getName(), value -> {
                    try { backend.rename(file, value); showFiles(); }
                    catch (IOException error) { toast(error.getMessage()); }
                });
                else new AlertDialog.Builder(this).setTitle("Delete " + file.getName() + "?")
                    .setNegativeButton("Cancel", null)
                    .setPositiveButton("Delete", (confirm, ignored) -> {
                        try { backend.delete(file); showFiles(); }
                        catch (IOException error) { toast(error.getMessage()); }
                    }).show();
            }).show();
    }

    private interface TextAction { void accept(String value); }

    private void prompt(String title, String hint, String initial, final TextAction action) {
        EditText input = new EditText(this);
        input.setHint(hint); input.setSingleLine(true); input.setText(initial); input.setSelectAllOnFocus(true);
        int spacing = dp(20);
        FrameLayout frame = new FrameLayout(this); frame.setPadding(spacing, 0, spacing, 0); frame.addView(input);
        new AlertDialog.Builder(this).setTitle(title).setView(frame).setNegativeButton("Cancel", null)
            .setPositiveButton("Save", (dialog, which) -> action.accept(input.getText().toString())).show();
    }

    private void showSettings() {
        LinearLayout body = page();
        body.addView(heading("Appearance"));
        body.addView(text("Choose the interface theme.", 15, false, R.color.nthn_muted));
        LinearLayout themes = new LinearLayout(this); themes.setOrientation(LinearLayout.HORIZONTAL);
        themes.addView(button("Light", v -> changeTheme(false)), new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
        themes.addView(button("Dark", v -> changeTheme(true)), new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
        body.addView(themes);
        body.addView(label("Configuration"));
        body.addView(row("OpenRouter", v -> show(NthnNavigation.AI)));
        body.addView(row("Terminal settings", v -> startActivity(new Intent(this, SettingsActivity.class))));
        body.addView(label("Environment"));
        body.addView(text("Linux prefix\n" + NthnBackend.PREFIX + "\n\nHome\n" + (backend == null ? "Unavailable" : backend.home().getAbsolutePath()), 14, false, R.color.nthn_muted));
    }

    private void changeTheme(boolean dark) {
        if (NthnTheme.isDark(this) == dark) return;
        NthnTheme.setDark(this, dark);
        recreate();
    }

    private interface TaskSuccess { void accept(Object value); }

    private void runTask(final java.util.concurrent.Callable<?> task, final TaskSuccess success, final TextView errorView) {
        executor.execute(() -> {
            try {
                final Object result = task.call();
                main.post(() -> { if (!destroyed) success.accept(result); });
            } catch (Exception error) {
                main.post(() -> { if (!destroyed) errorView.setText(message(error)); });
            }
        });
    }

    private String message(Throwable error) {
        return error.getMessage() == null ? "Operation failed" : error.getMessage();
    }

    private void toast(String message) { Toast.makeText(this, message, Toast.LENGTH_SHORT).show(); }

    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }

    private int resolveSelectableBackground() {
        android.util.TypedValue value = new android.util.TypedValue();
        getTheme().resolveAttribute(android.R.attr.selectableItemBackground, value, true);
        return value.resourceId;
    }

    private String formatBytes(long bytes) {
        double gib = bytes / 1073741824d;
        return String.format(Locale.US, "%.1f GB", gib);
    }
}
