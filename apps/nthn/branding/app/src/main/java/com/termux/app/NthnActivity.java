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
    private NthnDeviceController devices;
    private File currentDirectory;
    private String screen = NthnNavigation.HOME;
    private boolean destroyed;

    @Override public void onCreate(@Nullable Bundle state) {
        NthnTheme.apply(this);
        super.onCreate(state);
        setContentView(R.layout.activity_nthn);
        content = findViewById(R.id.nthn_content);
        devices = new NthnDeviceController(this);
        title = null;
        try {
            backend = new NthnBackend(this);
            currentDirectory = backend.home();
        } catch (IOException error) {
            Toast.makeText(this, error.getMessage(), Toast.LENGTH_LONG).show();
        }
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
        if (devices != null) devices.destroy();
        executor.shutdownNow();
        super.onDestroy();
    }

    @Override protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (devices != null) devices.onActivityResult(requestCode, resultCode, data);
    }

    @Override public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (devices != null) devices.onPermissionResult(requestCode, grantResults);
    }

    private void show(String requested) {
        screen = requested == null ? NthnNavigation.AI : requested;
        if (!screen.equals(NthnNavigation.HOME) && !screen.equals(NthnNavigation.AI)
            && !screen.equals(NthnNavigation.FILES) && !screen.equals(NthnNavigation.SETTINGS))
            screen = NthnNavigation.HOME;
        NthnAppState.record(this, screen);
        content.removeAllViews();
        findViewById(R.id.nthn_bottom_nav).setVisibility(screen.equals(NthnNavigation.AI) ? View.GONE : View.VISIBLE);
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
        body.setPadding(dp(20), dp(16), dp(20), dp(28));
        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        scroll.addView(body, new ScrollView.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        content.addView(scroll, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        return body;
    }

    private TextView heading(String value) {
        TextView view = text(value, 28, true, R.color.nthn_text);
        view.setPadding(0, 0, 0, dp(4));
        return view;
    }

    private TextView label(String value) {
        TextView view = text(value.toUpperCase(Locale.ROOT), 12, true, R.color.nthn_muted);
        view.setLetterSpacing(.09f);
        view.setPadding(dp(4), dp(22), 0, dp(9));
        return view;
    }

    private TextView text(String value, int sp, boolean bold, int color) {
        TextView view = new TextView(this);
        view.setText(value);
        view.setTextSize(sp);
        view.setTextColor(ContextCompat.getColor(this, color));
        view.setTypeface(Typeface.create("sans-serif", bold ? Typeface.BOLD : Typeface.NORMAL));
        view.setLineSpacing(0, 1.15f);
        return view;
    }

    private TextView row(String value, View.OnClickListener listener) {
        TextView view = text(value, 16, false, R.color.nthn_text);
        view.setGravity(Gravity.CENTER_VERTICAL);
        view.setMinHeight(dp(62));
        view.setPadding(dp(16), 0, dp(16), 0);
        view.setCompoundDrawablesWithIntrinsicBounds(0, 0, R.drawable.ic_nthn_chevron, 0);
        view.setCompoundDrawablePadding(dp(12));
        view.setBackground(panelBackground());
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        params.setMargins(0, 0, 0, dp(8));
        view.setLayoutParams(params);
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
        button.setTextColor(ContextCompat.getColor(this, R.color.nthn_text));
        GradientDrawable shape = panelBackground();
        shape.setCornerRadius(dp(12));
        button.setBackground(shape);
        button.setMinHeight(dp(44));
        button.setOnClickListener(listener);
        return button;
    }

    private void showHome() {
        final LinearLayout body = page();
        LinearLayout top = new LinearLayout(this);
        top.setGravity(Gravity.CENTER_VERTICAL);
        top.addView(text("◆  NTHN", 15, true, R.color.nthn_accent), new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
        final TextView badge = text("Checking…", 13, true, R.color.nthn_muted);
        badge.setPadding(dp(12), dp(7), dp(12), dp(7));
        badge.setBackground(panelBackground());
        top.addView(badge);
        body.addView(top);
        body.addView(label("Workspace"));
        body.addView(heading("Home"));
        body.addView(text("Your Linux environment", 14, false, R.color.nthn_muted));

        LinearLayout agent = new LinearLayout(this);
        agent.setGravity(Gravity.CENTER_VERTICAL);
        agent.setPadding(dp(16), dp(16), dp(16), dp(16));
        agent.setBackground(panelBackground());
        LinearLayout.LayoutParams agentParams = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        agentParams.setMargins(0, dp(22), 0, 0);
        body.addView(agent, agentParams);
        TextView avatar = text("J", 24, true, R.color.nthn_accent);
        avatar.setGravity(Gravity.CENTER);
        GradientDrawable avatarShape = panelBackground();
        avatarShape.setCornerRadius(dp(26));
        avatar.setBackground(avatarShape);
        agent.addView(avatar, new LinearLayout.LayoutParams(dp(52), dp(52)));
        LinearLayout agentCopy = new LinearLayout(this);
        agentCopy.setOrientation(LinearLayout.VERTICAL);
        agentCopy.setPadding(dp(16), 0, 0, 0);
        agentCopy.addView(text("Jef coding agent", 17, true, R.color.nthn_text));
        agentCopy.addView(text("Open your project chat", 14, false, R.color.nthn_muted));
        agent.addView(agentCopy);
        agent.setOnClickListener(v -> show(NthnNavigation.AI));
        agent.setFocusable(true);
        agent.setContentDescription("Open Jef coding agent");

        body.addView(label("Environment"));
        LinearLayout metrics = new LinearLayout(this);
        metrics.setOrientation(LinearLayout.HORIZONTAL);
        final TextView status = metric(metrics, "Status", "Checking…", "Linux shell");
        final TextView storage = metric(metrics, "Storage", "Checking…", "free on device");
        body.addView(metrics);
        final TextView nodeState = text("Checking Node…", 13, false, R.color.nthn_muted);
        nodeState.setPadding(dp(4), dp(10), 0, 0);
        body.addView(nodeState);
        body.addView(label("Open"));
        body.addView(row("Terminal", v -> NthnNavigation.open(this, "terminal")));
        body.addView(row("Jef AI", v -> show(NthnNavigation.AI)));
        body.addView(row("Files", v -> show(NthnNavigation.FILES)));
        if (backend == null) { badge.setText("Unavailable"); status.setText("Unavailable"); storage.setText("Unavailable"); nodeState.setText("Node unavailable"); return; }
        runTask(() -> backend.environmentStatus(), value -> {
            NthnBackend.EnvironmentStatus environment = (NthnBackend.EnvironmentStatus) value;
            badge.setText(environment.ready ? "●  Ready" : "●  Setup required");
            badge.setTextColor(ContextCompat.getColor(this, environment.ready ? R.color.nthn_accent : R.color.nthn_muted));
            status.setText(environment.ready ? "Ready" : "Setup needed");
            storage.setText(formatBytes(environment.freeBytes));
            nodeState.setText(environment.nodeReady ? "Node available" : "Node unavailable");
        }, status);
    }

    private TextView metric(LinearLayout parent, String name, String initial, String note) {
        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setPadding(dp(16), dp(14), dp(12), dp(14));
        card.setBackground(panelBackground());
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1);
        if (parent.getChildCount() > 0) params.setMargins(dp(10), 0, 0, 0);
        parent.addView(card, params);
        card.addView(text(name, 13, false, R.color.nthn_muted));
        TextView value = text(initial, 18, true, R.color.nthn_text);
        value.setPadding(0, dp(6), 0, dp(3));
        card.addView(value);
        card.addView(text(note, 12, false, R.color.nthn_muted));
        return value;
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

        @JavascriptInterface public void navigate(String destination) {
            if (destination == null) return;
            if (!destination.equals(NthnNavigation.HOME) && !destination.equals("terminal")
                && !destination.equals(NthnNavigation.AI) && !destination.equals(NthnNavigation.FILES)
                && !destination.equals(NthnNavigation.SETTINGS)) return;
            main.post(() -> {
                if (destroyed) return;
                if (destination.equals("terminal")) NthnNavigation.open(NthnActivity.this, "terminal");
                else if (!destination.equals(screen)) show(destination);
            });
        }

        @JavascriptInterface public void stop() {
            if (backend != null) backend.stop();
            executor.execute(() -> {
                try {
                    if (backend == null) return;
                    NthnBackend.CommandResult result = backend.agent("state", null);
                    deliver(result.ok() ? "snapshot" : "error", result.ok() ? result.output : aiMessage(result.output));
                } catch (Exception error) { deliver("error", message(error)); }
            });
        }
        private void agentAction(String command, String request) {
            executor.execute(() -> {
                try {
                    if (backend == null) throw new IOException("AI service unavailable until Linux setup completes.");
                    NthnBackend.CommandResult result = backend.agent(command, request == null ? null : request.toCharArray());
                    deliver(result.ok() ? "snapshot" : "error", result.ok() ? result.output : aiMessage(result.output));
                } catch (Exception error) { deliver("error", message(error)); }
            });
        }
        @JavascriptInterface public void selectConversation(String id) {
            if (id == null || !id.matches("[0-9a-f-]{36}")) return;
            try { agentAction("select", new JSONObject().put("conversationId", id).toString()); }
            catch (Exception error) { deliver("error", message(error)); }
        }
        @JavascriptInterface public void memories() { agentAction("memory-list", null); }
        @JavascriptInterface public void screenState(String value) { NthnAppState.recordDashboard(NthnActivity.this, value); }
        @JavascriptInterface public void modelPreference(String value) {
            if (!"automatic-free".equals(value) && !"manual-free".equals(value)) return;
            try { agentAction("model-preference", new JSONObject().put("value", value).toString()); }
            catch (Exception error) { deliver("error", message(error)); }
        }
        @JavascriptInterface public void communicationMode(String value) {
            if (!"standard".equals(value) && !"creator-direct".equals(value)) return;
            try { agentAction("communication-mode", new JSONObject().put("value", value).toString()); }
            catch (Exception error) { deliver("error", message(error)); }
        }
        @JavascriptInterface public void addMemory(String kind, String text, String scope) {
            if (kind == null || text == null || scope == null) return;
            try { agentAction("memory-add", new JSONObject().put("kind", kind).put("text", text).put("scope", scope).toString()); }
            catch (Exception error) { deliver("error", message(error)); }
        }
        @JavascriptInterface public void updateMemory(String id, String text, boolean pinned) {
            if (id == null || !id.matches("[0-9a-f-]{36}") || text == null) return;
            try { agentAction("memory-update", new JSONObject().put("id", id).put("text", text).put("pinned", pinned).toString()); }
            catch (Exception error) { deliver("error", message(error)); }
        }
        @JavascriptInterface public void removeMemory(String id) {
            if (id == null || !id.matches("[0-9a-f-]{36}")) return;
            try { agentAction("memory-remove", new JSONObject().put("id", id).toString()); }
            catch (Exception error) { deliver("error", message(error)); }
        }
        @JavascriptInterface public boolean darkTheme() { return NthnTheme.isDark(NthnActivity.this); }
        @JavascriptInterface public void captureCamera() { runOnUiThread(() -> devices.captureCamera(this::deliver)); }
        @JavascriptInterface public void listen() { runOnUiThread(() -> devices.listen(this::deliver)); }
        @JavascriptInterface public void stopListening() { runOnUiThread(() -> devices.stopListening(this::deliver)); }
        @JavascriptInterface public void locate() { runOnUiThread(() -> devices.locate(this::deliver)); }
        @JavascriptInterface public void importFile() { runOnUiThread(() -> devices.importFile(this::deliver)); }
        @JavascriptInterface public void speak(String text) { runOnUiThread(() -> devices.speak(this::deliver, text)); }

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
        @JavascriptInterface public void configureResearch() { runOnUiThread(() -> configureResearchProvider(this)); }
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
        @JavascriptInterface public void selectModel(String id) {
            if (id == null || id.isEmpty() || id.length() > 300) { deliver("error", "Invalid model ID."); return; }
            executor.execute(() -> {
                try {
                    if (backend == null) throw new IOException("AI service unavailable until Linux setup completes.");
                    NthnBackend.CommandResult result = backend.ai("select", id, null);
                    if (!result.ok()) { deliver("error", aiMessage(result.output)); return; }
                    deliver("status", "Model verified and selected");
                    NthnBackend.CommandResult models = backend.ai("cached-models", null, null);
                    if (models.ok()) deliver("models", models.output);
                    NthnBackend.CommandResult agent = backend.agent("state", null);
                    if (agent.ok()) deliver("snapshot", agent.output);
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

    private void configureResearchProvider(final AiWebBridge bridge) {
        final String[] choices = {"Brave Search API key", "SearXNG HTTPS endpoint"};
        new AlertDialog.Builder(this).setTitle("Configure Jef web search")
            .setMessage("Jef can open public HTTPS pages now. Choose a search provider to find pages by topic.")
            .setItems(choices, (dialog, selected) -> {
                EditText value = new EditText(this);
                value.setSingleLine(true);
                value.setHint(selected == 0 ? "Brave Search API key" : "https://your-search-server.example/");
                if (selected == 0) value.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
                FrameLayout frame = new FrameLayout(this);
                frame.setPadding(dp(20), 0, dp(20), 0);
                frame.addView(value);
                new AlertDialog.Builder(this).setTitle(choices[selected]).setView(frame)
                    .setNegativeButton("Cancel", null)
                    .setPositiveButton("Save", (next, which) -> {
                        String entered = value.getText().toString().trim();
                        value.setText("");
                        if (entered.isEmpty()) { bridge.deliver("error", "Enter a search key or endpoint."); return; }
                        try {
                            JSONObject request = new JSONObject().put("kind", selected == 0 ? "brave" : "searxng")
                                .put(selected == 0 ? "apiKey" : "endpoint", entered);
                            bridge.agentAction("research-config", request.toString());
                        } catch (Exception error) { bridge.deliver("error", message(error)); }
                    }).show();
            }).setNegativeButton("Cancel", null).show();
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

    private String aiMessage(String output) {
        try {
            JSONObject value = new JSONObject(output);
            if (value.has("message")) return value.getString("message");
            String connection = value.optString("connection", "Not connected");
            String credentials = value.optString("credentials", "");
            String selected = value.optString("selectedModel", "");
            String inference = value.optString("inference", "");
            String jefChat = value.optString("jefChat", "");
            String result = connection;
            if (!credentials.isEmpty()) result += "  ·  credentials " + credentials;
            if (!selected.isEmpty() && !"null".equals(selected)) result += "\nSelected: " + selected;
            if (!inference.isEmpty() && !"null".equals(inference)) result += "  ·  inference " + inference;
            if (!jefChat.isEmpty() && !"null".equals(jefChat)) result += "  ·  Jef chat " + jefChat;
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
        body.addView(heading("Files"));
        TextView path = text(relative, 14, false, R.color.nthn_muted);
        path.setTypeface(Typeface.MONOSPACE);
        body.addView(path);
        LinearLayout actions = new LinearLayout(this);
        actions.setOrientation(LinearLayout.HORIZONTAL);
        actions.addView(button("New file", v -> createEntry(false)), new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
        LinearLayout.LayoutParams folderParams = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1);
        folderParams.setMargins(dp(10), 0, 0, 0);
        actions.addView(button("New folder", v -> createEntry(true)), folderParams);
        LinearLayout.LayoutParams actionsParams = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        actionsParams.setMargins(0, dp(18), 0, dp(14));
        body.addView(actions, actionsParams);
        if (!currentDirectory.equals(backend.home())) body.addView(row("..", v -> { currentDirectory = currentDirectory.getParentFile(); showFiles(); }));
        try {
            List<File> files = backend.listFiles(currentDirectory);
            if (files.isEmpty()) body.addView(text("This folder is empty.", 15, false, R.color.nthn_muted));
            for (final File file : files) {
                TextView item = row((file.isDirectory() ? "▣  " : "") + file.getName(), v -> openFile(file));
                item.setOnLongClickListener(v -> { manageFile(file); return true; });
                LinearLayout fileRow = new LinearLayout(this);
                fileRow.setGravity(Gravity.CENTER_VERTICAL);
                fileRow.addView(item, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
                Button manage = button("⋯", v -> manageFile(file));
                manage.setContentDescription("Manage " + file.getName());
                LinearLayout.LayoutParams manageParams = new LinearLayout.LayoutParams(dp(48), dp(48));
                manageParams.setMargins(dp(8), 0, 0, 0);
                fileRow.addView(manage, manageParams);
                LinearLayout.LayoutParams fileRowParams = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
                fileRowParams.setMargins(0, 0, 0, dp(8));
                body.addView(fileRow, fileRowParams);
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
        body.addView(heading("Settings"));
        body.addView(label("Appearance"));
        body.addView(text("Choose the interface theme.", 15, false, R.color.nthn_muted));
        LinearLayout themes = new LinearLayout(this); themes.setOrientation(LinearLayout.HORIZONTAL);
        themes.addView(themeButton("Light", false), new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
        LinearLayout.LayoutParams darkParams = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1);
        darkParams.setMargins(dp(10), 0, 0, 0);
        themes.addView(themeButton("Dark", true), darkParams);
        LinearLayout.LayoutParams themesParams = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        themesParams.setMargins(0, dp(14), 0, 0);
        body.addView(themes, themesParams);
        body.addView(label("Configuration"));
        body.addView(row("Jef and AI providers", v -> show(NthnNavigation.AI)));
        body.addView(row("Check for app updates", v -> checkForAppUpdate()));
        body.addView(row("Private release access", v -> configureReleaseAccess()));
        body.addView(row("GitHub update write access", v -> configureGithubWriteAccess()));
        body.addView(row("Run NTHN build workflow", v -> dispatchGithubWorkflow()));
        body.addView(row("Terminal settings", v -> startActivity(new Intent(this, SettingsActivity.class))));
        body.addView(label("Environment"));
        body.addView(text("Linux prefix\n" + NthnBackend.PREFIX + "\n\nHome\n" + (backend == null ? "Unavailable" : backend.home().getAbsolutePath()), 14, false, R.color.nthn_muted));
    }

    private Button themeButton(String name, boolean dark) {
        Button choice = button(name, v -> changeTheme(dark));
        if (NthnTheme.isDark(this) == dark) {
            GradientDrawable selected = new GradientDrawable();
            selected.setColor(ContextCompat.getColor(this, R.color.nthn_accent));
            selected.setCornerRadius(dp(12));
            choice.setBackground(selected);
            choice.setTextColor(ContextCompat.getColor(this, R.color.nthn_on_accent));
        }
        return choice;
    }

    private void changeTheme(boolean dark) {
        if (NthnTheme.isDark(this) == dark) return;
        NthnTheme.setDark(this, dark);
        recreate();
    }

    private void configureReleaseAccess() {
        EditText key = new EditText(this);
        key.setSingleLine(true);
        key.setHint("GitHub read token");
        key.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        FrameLayout frame = new FrameLayout(this);
        frame.setPadding(dp(20), 0, dp(20), 0);
        frame.addView(key);
        new AlertDialog.Builder(this).setTitle("Private release access")
            .setMessage("Use a fine-grained GitHub token with read access to this private NTHN repository. The token stays encrypted in NTHN app storage. Leave blank to remove it.")
            .setView(frame).setNegativeButton("Cancel", null)
            .setPositiveButton("Save", (dialog, which) -> {
                final String token = key.getText().toString().trim();
                key.setText("");
                executor.execute(() -> {
                    try {
                        if (backend == null) throw new IOException("AI service is unavailable.");
                        String request = new JSONObject().put("token", token).toString();
                        NthnBackend.CommandResult result = backend.agent("release-config", request.toCharArray());
                        if (!result.ok()) throw new IOException(aiMessage(result.output));
                        main.post(() -> toast(token.isEmpty() ? "Release access removed" : "Release access saved"));
                    } catch (Exception error) { main.post(() -> toast(message(error))); }
                });
            }).show();
    }

    private void configureGithubWriteAccess() {
        EditText key = new EditText(this);
        key.setSingleLine(true);
        key.setHint("GitHub Actions write token");
        key.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        FrameLayout frame = new FrameLayout(this);
        frame.setPadding(dp(20), 0, dp(20), 0);
        frame.addView(key);
        new AlertDialog.Builder(this).setTitle("GitHub update write access")
            .setMessage("Use a fine-grained token limited to this repository with Actions write and Contents read permissions. This token is stored separately from release read access. Leave blank to remove it.")
            .setView(frame).setNegativeButton("Cancel", null)
            .setPositiveButton("Save", (dialog, which) -> {
                final String token = key.getText().toString().trim();
                key.setText("");
                executor.execute(() -> {
                    try {
                        if (backend == null) throw new IOException("AI service is unavailable.");
                        String request = new JSONObject().put("token", token).toString();
                        NthnBackend.CommandResult result = backend.agent("github-write-config", request.toCharArray());
                        if (!result.ok()) throw new IOException(aiMessage(result.output));
                        main.post(() -> toast(token.isEmpty() ? "GitHub write access removed" : "GitHub write access saved"));
                    } catch (Exception error) { main.post(() -> toast(message(error))); }
                });
            }).show();
    }

    private void dispatchGithubWorkflow() {
        EditText branch = new EditText(this);
        branch.setSingleLine(true);
        branch.setText("codex/jef-v2");
        FrameLayout frame = new FrameLayout(this);
        frame.setPadding(dp(20), 0, dp(20), 0);
        frame.addView(branch);
        new AlertDialog.Builder(this).setTitle("Run NTHN build workflow?")
            .setMessage("This dispatches the real GitHub Actions workflow for the branch below. Build and release steps may run on GitHub. Review the branch before confirming.")
            .setView(frame).setNegativeButton("Cancel", null)
            .setPositiveButton("Dispatch", (dialog, which) -> {
                final String ref = branch.getText().toString().trim();
                executor.execute(() -> {
                    try {
                        if (backend == null) throw new IOException("AI service is unavailable.");
                        String request = new JSONObject().put("branch", ref).toString();
                        NthnBackend.CommandResult result = backend.agent("github-dispatch", request.toCharArray());
                        if (!result.ok()) throw new IOException(aiMessage(result.output));
                        main.post(() -> toast("GitHub build dispatched for " + ref));
                    } catch (Exception error) { main.post(() -> toast(message(error))); }
                });
            }).show();
    }

    private void checkForAppUpdate() {
        executor.execute(() -> {
            try {
                if (backend == null) throw new IOException("AI service is unavailable.");
                NthnBackend.CommandResult result = backend.agent("update-check", null);
                if (!result.ok()) throw new IOException(aiMessage(result.output));
                JSONObject release = new JSONObject(result.output).optJSONObject("release");
                if (release == null) { main.post(() -> toast("NTHN is up to date")); return; }
                String version = release.optString("version", "new version");
                long bytes = release.optLong("size", 0);
                main.post(() -> {
                    if (destroyed) return;
                    new AlertDialog.Builder(this).setTitle("NTHN V" + version + " available")
                        .setMessage("Download the verified APK (" + Math.max(1, bytes / 1_000_000) + " MB)? Android will ask before installation.")
                        .setNegativeButton("Cancel", null)
                        .setPositiveButton("Download", (dialog, which) -> downloadAppUpdate(version))
                        .show();
                });
            } catch (Exception error) { main.post(() -> toast(message(error))); }
        });
    }

    private void downloadAppUpdate(String version) {
        toast("Downloading NTHN V" + version);
        executor.execute(() -> {
            try {
                NthnBackend.CommandResult result = backend.agent("update-download", null);
                if (!result.ok()) throw new IOException(aiMessage(result.output));
                JSONObject apk = new JSONObject(result.output).optJSONObject("apk");
                if (apk == null) throw new IOException("No newer APK is available.");
                File file = new File(apk.getString("path"));
                NthnUpdater.verify(this, file);
                main.post(() -> {
                    if (destroyed) return;
                    new AlertDialog.Builder(this).setTitle("Install NTHN V" + version)
                        .setMessage("The APK checksum, app identity, version, and signing certificate were verified. Continue to Android's installer?")
                        .setNegativeButton("Later", null)
                        .setPositiveButton("Install", (dialog, which) -> {
                            try {
                                if (!NthnUpdater.install(this, file)) toast("Allow NTHN as an install source, then check for updates again.");
                            } catch (Exception error) { toast(message(error)); }
                        }).show();
                });
            } catch (Exception error) { main.post(() -> toast(message(error))); }
        });
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
