package com.termux.app;

import android.app.AlertDialog;
import android.content.Intent;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
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
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.JavascriptInterface;

import androidx.annotation.Nullable;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.content.ContextCompat;

import com.termux.R;
import com.termux.app.activities.SettingsActivity;

import org.json.JSONObject;
import org.json.JSONArray;

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
    private JSONArray alexHistory = new JSONArray();
    private static final String ALEX_PREFERENCES = "nthn-alex";
    private static final String ALEX_HISTORY = "conversation";

    @Override public void onCreate(@Nullable Bundle state) {
        NthnTheme.apply(this);
        super.onCreate(state);
        setContentView(R.layout.activity_nthn);
        content = findViewById(R.id.nthn_content);
        title = null;
        try {
            backend = new NthnBackend(this);
            currentDirectory = backend.home();
        } catch (IOException error) {
            Toast.makeText(this, error.getMessage(), Toast.LENGTH_LONG).show();
        }
        loadAlexHistory();
        show(getIntent().getStringExtra(NthnNavigation.EXTRA_SCREEN));
        TermuxInstaller.setupBootstrapIfNeeded(this, () -> {
            if (destroyed) return;
            NthnAiInstaller.install(this);
            show(screen);
        });
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
            if (title != null) title.setText("Jef"); selected = R.id.nav_ai; showAi();
        } else if (screen.equals(NthnNavigation.FILES)) {
            if (title != null) title.setText("Files"); selected = R.id.nav_files; showFiles();
        } else if (screen.equals(NthnNavigation.SETTINGS)) {
            if (title != null) title.setText("Settings"); selected = R.id.nav_settings; showSettings();
        } else {
            if (title != null) title.setText("NTHN"); selected = R.id.nav_home; showHome();
        }
        NthnNavigation.attach(this, selected);
    }

    private LinearLayout page() {
        LinearLayout body = new LinearLayout(this);
        body.setOrientation(LinearLayout.VERTICAL);
        body.setPadding(dp(22), dp(22), dp(22), dp(36));
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
        view.setMinHeight(dp(58));
        view.setPadding(dp(12), 0, dp(12), 0);
        view.setCompoundDrawablesWithIntrinsicBounds(0, 0, R.drawable.ic_nthn_chevron, 0);
        view.setCompoundDrawablePadding(dp(12));
        view.setBackgroundResource(resolveSelectableBackground());
        view.setOnClickListener(listener);
        return view;
    }

    private GradientDrawable panelBackground() {
        GradientDrawable shape = new GradientDrawable();
        shape.setColor(ContextCompat.getColor(this, R.color.nthn_panel));
        shape.setCornerRadius(dp(16));
        shape.setStroke(dp(1), ContextCompat.getColor(this, R.color.nthn_divider));
        return shape;
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
        body.addView(label("NTHN WORKSPACE"));
        body.addView(heading("Make something today."));
        body.addView(text("Code with Jef, work in the terminal, and keep your projects here.", 15, false, R.color.nthn_muted));
        LinearLayout environmentCard = new LinearLayout(this);
        environmentCard.setOrientation(LinearLayout.VERTICAL);
        environmentCard.setPadding(dp(18), dp(16), dp(18), dp(16));
        environmentCard.setBackground(panelBackground());
        LinearLayout.LayoutParams cardParams = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        cardParams.setMargins(0, dp(28), 0, dp(6));
        body.addView(environmentCard, cardParams);
        environmentCard.addView(text("LINUX ENVIRONMENT", 11, true, R.color.nthn_accent));
        final TextView status = text("Checking…", 16, false, R.color.nthn_text);
        status.setPadding(0, dp(10), 0, 0);
        environmentCard.addView(status);
        body.addView(label("WORKSPACE"));
        body.addView(row("Jef coding agent", v -> show(NthnNavigation.AI)));
        body.addView(row("Terminal", v -> NthnNavigation.open(this, "terminal")));
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
        WebView web = new WebView(this);
        web.setBackgroundColor(ContextCompat.getColor(this, R.color.nthn_surface));
        web.getSettings().setJavaScriptEnabled(true);
        web.getSettings().setDomStorageEnabled(false);
        web.setWebViewClient(new WebViewClient());
        web.addJavascriptInterface(new AiWebBridge(web), "NthnAI");
        content.addView(web, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        web.loadUrl("file:///android_asset/nthn_chat.html");
    }

    private final class AiWebBridge {
        private final WebView web;
        AiWebBridge(WebView web) { this.web = web; }

        @JavascriptInterface public String history() { return "[]"; }
        @JavascriptInterface public boolean darkTheme() { return NthnTheme.isDark(NthnActivity.this); }

        @JavascriptInterface public void send(String request) {
            if (request == null || request.trim().isEmpty()) return;
            final String payload;
            try { payload = new JSONObject().put("text", request.trim()).toString(); }
            catch (Exception error) { deliver("error", message(error)); return; }
            executor.execute(() -> {
                try {
                    if (backend == null) throw new IOException("AI service unavailable until Linux setup completes.");
                    NthnBackend.CommandResult result = backend.agentStream("chat-stream", payload.toCharArray(), line -> deliver("progress", line));
                    if (!result.ok()) { deliver("error", aiMessage(result.output)); return; }
                    deliver("snapshot", result.output);
                } catch (Exception error) { deliver("error", message(error)); }
            });
        }

        @JavascriptInterface public void configure() { runOnUiThread(() -> configureWebProvider(this)); }
        @JavascriptInterface public void models() {
            executor.execute(() -> {
                try {
                    if (backend == null) throw new IOException("AI service unavailable until Linux setup completes.");
                    NthnBackend.CommandResult result = backend.ai("models", null, null);
                    if (result.ok()) deliver("models", result.output);
                    else deliver("error", aiMessage(result.output));
                } catch (Exception error) { deliver("error", message(error)); }
            });
        }
        @JavascriptInterface public void removeAccount(String id) {
            if (id == null || !id.matches("[0-9a-f-]{36}")) { deliver("error", "Invalid account ID."); return; }
            runOnUiThread(() -> new AlertDialog.Builder(NthnActivity.this)
                .setTitle("Remove AI account?")
                .setMessage("This removes the account and its stored API key from NTHN.")
                .setNegativeButton("Cancel", null)
                .setPositiveButton("Remove", (dialog, which) -> executor.execute(() -> {
                    try {
                        if (backend == null) throw new IOException("AI service unavailable until Linux setup completes.");
                        NthnBackend.CommandResult result = backend.ai("remove-account", id, null);
                        if (!result.ok()) { deliver("error", aiMessage(result.output)); return; }
                        deliver("status", "AI account removed");
                        NthnBackend.CommandResult accounts = backend.ai("accounts", null, null);
                        if (accounts.ok()) deliver("accounts", accounts.output);
                        NthnBackend.CommandResult models = backend.ai("cached-models", null, null);
                        deliver("models", models.ok() ? models.output : "");
                    } catch (Exception error) { deliver("error", message(error)); }
                })).show());
        }
        @JavascriptInterface public void workspace(String path) {
            if (path == null || path.length() > 500) { deliver("error", "Choose a project folder inside Linux home."); return; }
            final String payload;
            try { payload = new JSONObject().put("path", path).toString(); }
            catch (Exception error) { deliver("error", message(error)); return; }
            executor.execute(() -> {
                try {
                    if (backend == null) throw new IOException("AI service unavailable until Linux setup completes.");
                    NthnBackend.CommandResult result = backend.agent("workspace", payload.toCharArray());
                    if (!result.ok()) { deliver("error", aiMessage(result.output)); return; }
                    deliver("snapshot", result.output);
                } catch (Exception error) { deliver("error", message(error)); }
            });
        }
        @JavascriptInterface public void newConversation() {
            executor.execute(() -> {
                try {
                    if (backend == null) throw new IOException("AI service unavailable until Linux setup completes.");
                    NthnBackend.CommandResult result = backend.agent("new", null);
                    if (!result.ok()) { deliver("error", aiMessage(result.output)); return; }
                    deliver("snapshot", result.output);
                } catch (Exception error) { deliver("error", message(error)); }
            });
        }
        @JavascriptInterface public void approve(String conversationId, String approvalId, boolean approved) {
            if (conversationId == null || approvalId == null) return;
            final String payload;
            try {
                payload = new JSONObject().put("conversationId", conversationId).put("approvalId", approvalId).put("approved", approved).toString();
            } catch (Exception error) { deliver("error", message(error)); return; }
            executor.execute(() -> {
                try {
                    if (backend == null) throw new IOException("AI service unavailable until Linux setup completes.");
                    NthnBackend.CommandResult result = backend.agentStream("approve-stream", payload.toCharArray(), line -> deliver("progress", line));
                    if (!result.ok()) { deliver("error", aiMessage(result.output)); return; }
                    deliver("snapshot", result.output);
                } catch (Exception error) { deliver("error", message(error)); }
            });
        }
        @JavascriptInterface public void status() {
            executor.execute(() -> {
                try {
                    if (backend == null) throw new IOException("AI service unavailable until Linux setup completes.");
                    NthnBackend.CommandResult provider = backend.ai("status", null, null);
                    deliver(provider.ok() ? "status" : "error", aiMessage(provider.output));
                    NthnBackend.CommandResult accounts = backend.ai("accounts", null, null);
                    if (accounts.ok()) deliver("accounts", accounts.output);
                    NthnBackend.CommandResult agent = backend.agent("state", null);
                    if (agent.ok()) deliver("snapshot", agent.output);
                    else deliver("error", aiMessage(agent.output));
                    if (accounts.ok() && !"[]".equals(accounts.output.trim())) {
                        NthnBackend.CommandResult models = backend.ai("cached-models", null, null);
                        if (models.ok()) deliver("models", models.output);
                    }
                }
                catch (Exception error) { deliver("error", message(error)); }
            });
        }

        private void deliver(String event, String value) {
            try {
                String encoded = org.json.JSONObject.quote(value == null ? "" : value);
                main.post(() -> { if (!destroyed) web.evaluateJavascript("window.nthnEvent(" + org.json.JSONObject.quote(event) + "," + encoded + ")", null); });
            } catch (Exception ignored) { }
        }
    }

    private void configureWebProvider(final AiWebBridge bridge) {
        final EditText key = new EditText(this);
        key.setSingleLine(true);
        key.setHint("Paste an API key");
        key.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        FrameLayout frame = new FrameLayout(this);
        frame.setPadding(dp(20), 0, dp(20), 0);
        frame.addView(key);
        new AlertDialog.Builder(this).setTitle("Add AI account")
            .setMessage("NTHN suggests a provider from the key format. You confirm where the key is sent.")
            .setView(frame).setNegativeButton("Cancel", null)
            .setNeutralButton("Local Ollama", (dialog, which) -> executor.execute(() -> connectWebProvider(bridge, "ollama", new char[0])))
            .setPositiveButton("Next", (dialog, which) -> {
                final char[] secret = key.getText().toString().trim().toCharArray();
                key.setText("");
                if (secret.length == 0) { toast("Enter an API key"); return; }
                executor.execute(() -> {
                    try {
                        if (backend == null) throw new IOException("AI service unavailable until Linux setup completes.");
                        NthnBackend.CommandResult hint = backend.ai("detect-provider-stdin", null, secret.clone());
                        if (!hint.ok()) throw new IOException(aiMessage(hint.output));
                        String suggested = new JSONObject(hint.output).optString("providerId", "");
                        main.post(() -> chooseWebProvider(bridge, secret, suggested));
                    } catch (Exception error) { java.util.Arrays.fill(secret, '\0'); bridge.deliver("error", message(error)); }
                });
            }).show();
    }

    private void chooseWebProvider(final AiWebBridge bridge, final char[] secret, final String suggested) {
        final String[] names = {"OpenRouter", "OpenAI", "Anthropic", "Google Gemini", "xKiro", "Groq"};
        final String[] ids = {"openrouter", "openai", "anthropic", "gemini", "xkiro", "groq"};
        final String[] choices = names.clone();
        for (int i = 0; i < ids.length; i++) if (ids[i].equals(suggested)) choices[i] += " (suggested)";
        new AlertDialog.Builder(this).setTitle(suggested.isEmpty() ? "Choose the key's provider" : "Confirm the suggested provider")
            .setMessage("Your key will be tested only with the provider you choose.")
            .setItems(choices, (dialog, selected) -> executor.execute(() -> connectWebProvider(bridge, ids[selected], secret)))
            .setOnCancelListener(dialog -> java.util.Arrays.fill(secret, '\0'))
            .show();
    }

    private void connectWebProvider(final AiWebBridge bridge, final String providerId, final char[] secret) {
        try {
            String command = "openrouter".equals(providerId) ? "add-account-stdin" : "add-provider-stdin";
            NthnBackend.CommandResult result = backend.ai(command, "openrouter".equals(providerId) ? null : providerId, secret);
            bridge.deliver("status", result.ok() ? "AI provider connected" : aiMessage(result.output));
            NthnBackend.CommandResult accounts = backend.ai("accounts", null, null);
            if (accounts.ok()) bridge.deliver("accounts", accounts.output);
            if (result.ok()) {
                NthnBackend.CommandResult models = backend.ai("models", null, null);
                if (models.ok()) bridge.deliver("models", models.output);
            }
        } catch (Exception error) { java.util.Arrays.fill(secret, '\0'); bridge.deliver("error", message(error)); }
    }

    private void loadAlexHistory() {
        String raw = getSharedPreferences(ALEX_PREFERENCES, MODE_PRIVATE).getString(ALEX_HISTORY, "");
        if (raw == null || raw.isEmpty()) return;
        try { alexHistory = new JSONArray(raw); }
        catch (Exception ignored) { alexHistory = new JSONArray(); }
    }

    private void saveAlexHistory() {
        getSharedPreferences(ALEX_PREFERENCES, MODE_PRIVATE).edit().putString(ALEX_HISTORY, alexHistory.toString()).apply();
    }

    private void clearAlexHistory() {
        alexHistory = new JSONArray();
        saveAlexHistory();
    }

    private void appendAlexMessage(String role, String content) {
        if (!"user".equals(role) && !"assistant".equals(role)) return;
        String text = content == null ? "" : content.trim();
        if (text.isEmpty()) return;
        while (alexHistory.length() >= 40) alexHistory.remove(0);
        JSONObject item = new JSONObject();
        try {
            item.put("role", role);
            item.put("content", text.length() > 20000 ? text.substring(0, 20000) : text);
            alexHistory.put(item);
            saveAlexHistory();
        } catch (Exception ignored) { }
    }

    private void renderAlexHistory(LinearLayout transcript) {
        for (int index = 0; index < alexHistory.length(); index++) {
            try {
                JSONObject item = alexHistory.getJSONObject(index);
                String role = item.optString("role");
                String content = item.optString("content");
                if ((!"user".equals(role) && !"assistant".equals(role)) || content.isEmpty()) continue;
                TextView message = text(("user".equals(role) ? "You\n" : "Jef\n") + content, 15, "user".equals(role), R.color.nthn_text);
                message.setPadding(dp(12), dp(10), dp(12), dp(10));
                message.setBackgroundResource(resolveSelectableBackground());
                LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
                params.setMargins(0, 0, 0, dp(8));
                transcript.addView(message, params);
            } catch (Exception ignored) { }
        }
    }

    private void sendAlex(final String request, final TextView status) {
        if (backend == null) { status.setText("AI service unavailable until Linux setup completes."); return; }
        appendAlexMessage("user", request);
        status.setText("Jef is thinking…");
        final String payload;
        try { payload = new JSONObject().put("messages", alexHistory).toString(); }
        catch (Exception error) { status.setText(message(error)); return; }
        executor.execute(() -> {
            try {
                NthnBackend.CommandResult result = backend.ai("chat", null, payload.toCharArray());
                main.post(() -> {
                    if (destroyed || !screen.equals(NthnNavigation.AI)) return;
                    if (!result.ok()) { status.setText(aiMessage(result.output)); return; }
                    try {
                        String reply = new JSONObject(result.output).optString("message");
                        if (reply.isEmpty()) throw new IllegalStateException("The model returned no text.");
                        appendAlexMessage("assistant", reply);
                        showAi();
                    } catch (Exception error) { status.setText(message(error)); }
                });
            } catch (Exception error) {
                main.post(() -> { if (!destroyed && screen.equals(NthnNavigation.AI)) status.setText(message(error)); });
            }
        });
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
        body.addView(row("Jef and AI providers", v -> show(NthnNavigation.AI)));
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
