package com.termux.app;

import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import androidx.core.content.FileProvider;

import java.io.File;
import java.io.IOException;
import java.util.Arrays;

/** Verifies a downloaded NTHN APK before asking Android to install it. */
final class NthnUpdater {
    private NthnUpdater() { }

    private static Signature[] signatures(PackageInfo info) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P && info.signingInfo != null)
            return info.signingInfo.getApkContentsSigners();
        return info.signatures;
    }

    private static long versionCode(PackageInfo info) {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.P ? info.getLongVersionCode() : info.versionCode;
    }

    static void verify(Activity activity, File downloaded) throws IOException {
        File root = new File(activity.getFilesDir(), "nthn-ai/.local/agent/updates").getCanonicalFile();
        File apk = downloaded.getCanonicalFile();
        if (!apk.getParentFile().equals(root) || !apk.isFile() || !apk.getName().matches("nthn-V[0-9.]+\\.apk"))
            throw new IOException("Update APK is outside NTHN's verified download folder.");
        PackageManager packages = activity.getPackageManager();
        int flags = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P ? PackageManager.GET_SIGNING_CERTIFICATES : PackageManager.GET_SIGNATURES;
        PackageInfo candidate = packages.getPackageArchiveInfo(apk.getAbsolutePath(), flags);
        if (candidate == null || !activity.getPackageName().equals(candidate.packageName))
            throw new IOException("Downloaded APK has a different package identity.");
        try {
            PackageInfo installed = packages.getPackageInfo(activity.getPackageName(), flags);
            Signature[] expected = signatures(installed), actual = signatures(candidate);
            if (expected == null || actual == null || expected.length != 1 || actual.length != 1 ||
                !Arrays.equals(expected[0].toByteArray(), actual[0].toByteArray()))
                throw new IOException("Downloaded APK has a different signing certificate.");
            if (versionCode(candidate) <= versionCode(installed))
                throw new IOException("Downloaded APK is not newer than the installed app.");
        } catch (PackageManager.NameNotFoundException error) {
            throw new IOException("Installed NTHN package could not be verified.", error);
        }
    }

    /** Returns false after opening Android's one-time unknown-source settings. */
    static boolean install(Activity activity, File downloaded) throws IOException {
        verify(activity, downloaded);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !activity.getPackageManager().canRequestPackageInstalls()) {
            Intent settings = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                Uri.parse("package:" + activity.getPackageName()));
            activity.startActivity(settings);
            return false;
        }
        Uri uri = FileProvider.getUriForFile(activity, activity.getPackageName() + ".nthnupdates", downloaded);
        Intent installer = new Intent(Intent.ACTION_INSTALL_PACKAGE);
        installer.setDataAndType(uri, "application/vnd.android.package-archive");
        installer.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        activity.startActivity(installer);
        return true;
    }
}
