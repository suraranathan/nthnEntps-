package com.termux.app;

import android.app.Activity;
import android.content.Intent;
import android.view.View;
import android.widget.TextView;

import androidx.core.content.ContextCompat;
import androidx.core.widget.TextViewCompat;

import com.termux.R;

final class NthnNavigation {
    static final String EXTRA_SCREEN = "nthn-screen";
    static final String HOME = "home";
    static final String AI = "ai";
    static final String FILES = "files";
    static final String SETTINGS = "settings";

    private NthnNavigation() {}

    static void attach(final Activity activity, int selectedId) {
        bind(activity, R.id.nav_home, HOME, selectedId);
        bind(activity, R.id.nav_terminal, "terminal", selectedId);
        bind(activity, R.id.nav_ai, AI, selectedId);
        bind(activity, R.id.nav_files, FILES, selectedId);
        bind(activity, R.id.nav_settings, SETTINGS, selectedId);
    }

    private static void bind(final Activity activity, final int id, final String screen, int selectedId) {
        TextView view = activity.findViewById(id);
        if (view == null) return;
        int color = ContextCompat.getColor(activity,
            id == selectedId ? R.color.nthn_text : R.color.nthn_muted);
        view.setTextColor(color);
        TextViewCompat.setCompoundDrawableTintList(view, android.content.res.ColorStateList.valueOf(color));
        view.setSelected(id == selectedId);
        view.setOnClickListener(v -> open(activity, screen));
    }

    static void open(Activity activity, String screen) {
        if ("terminal".equals(screen)) {
            if (activity instanceof TermuxActivity) return;
            activity.startActivity(new Intent(activity, TermuxActivity.class));
            return;
        }
        Intent intent = new Intent(activity, NthnActivity.class)
            .putExtra(EXTRA_SCREEN, screen)
            .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        activity.startActivity(intent);
        if (activity instanceof TermuxActivity) activity.finish();
    }
}
