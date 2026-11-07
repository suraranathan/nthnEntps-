package com.termux.app;

import android.content.Context;
import android.content.SharedPreferences;

import androidx.appcompat.app.AppCompatActivity;
import androidx.appcompat.app.AppCompatDelegate;

import com.termux.shared.theme.NightMode;

final class NthnTheme {
    private static final String PREFERENCES = "nthn-ui";
    private static final String DARK = "dark-theme";

    private NthnTheme() {}

    static boolean isDark(Context context) {
        return context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
            .getBoolean(DARK, true);
    }

    static void apply(AppCompatActivity activity) {
        boolean dark = isDark(activity);
        NightMode.setAppNightMode(dark ? "true" : "false");
        activity.getDelegate().setLocalNightMode(
            dark ? AppCompatDelegate.MODE_NIGHT_YES : AppCompatDelegate.MODE_NIGHT_NO);
    }

    static void setDark(Context context, boolean dark) {
        SharedPreferences preferences = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE);
        preferences.edit().putBoolean(DARK, dark).apply();
        NightMode.setAppNightMode(dark ? "true" : "false");
    }
}
