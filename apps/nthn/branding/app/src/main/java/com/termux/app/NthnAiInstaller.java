package com.termux.app;

import android.content.Context;

import com.termux.shared.logger.Logger;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;

/** Installs the provider CLI beside the app's own Node runtime, without changing the bootstrap. */
final class NthnAiInstaller {
    private static final String PREFIX = "/data/data/com.nthn/files/usr";

    static void install(Context context) {
        if (!new File(PREFIX, "bin/node").isFile()) return;
        try {
            File root = new File(context.getFilesDir(), "nthn-ai");
            copyAssets(context, "nthn-ai", root);
            File launcher = new File(PREFIX, "bin/nthn-ai");
            byte[] script = ("#!" + PREFIX + "/bin/sh\nexec " + PREFIX + "/bin/node " +
                new File(root, "server/ai/nthn-cli.ts").getAbsolutePath() + " \"$@\"\n")
                .getBytes(StandardCharsets.UTF_8);
            try (FileOutputStream out = new FileOutputStream(launcher)) { out.write(script); out.getFD().sync(); }
            if (!launcher.setExecutable(true, true)) throw new IOException("launcher permission");
        } catch (IOException error) {
            Logger.logError("NthnAiInstaller", "Provider tools could not be installed");
        }
    }

    private static void copyAssets(Context context, String assetPath, File destination) throws IOException {
        String[] children = context.getAssets().list(assetPath);
        if (children == null) throw new IOException("provider assets missing");
        if (children.length > 0) {
            if (!destination.exists() && !destination.mkdirs()) throw new IOException("provider directory unavailable");
            for (String child : children) copyAssets(context, assetPath + "/" + child, new File(destination, child));
        } else {
            try (InputStream input = context.getAssets().open(assetPath);
                 FileOutputStream output = new FileOutputStream(destination)) {
                byte[] buffer = new byte[8192]; int count;
                while ((count = input.read(buffer)) != -1) output.write(buffer, 0, count);
                output.getFD().sync();
            }
        }
    }
}
