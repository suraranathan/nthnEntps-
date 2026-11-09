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
    private static final String[] PROOT_RUNTIME = {
        "bin/proot", "libexec/proot/loader", "lib/libtalloc.so.2", "lib/libandroid-shmem.so"
    };

    static void install(Context context) {
        if (!new File(PREFIX, "bin/node").isFile()) return;
        try {
            File root = new File(context.getFilesDir(), "nthn-ai");
            copyAssets(context, "nthn-ai", root);
            installProotRuntime(root);
            NthnSourceInstaller.install(context);
            installLauncher(new File(PREFIX, "bin/nthn-ai"), new File(root, "server/ai/nthn-cli.ts"));
            installLauncher(new File(PREFIX, "bin/nthn-agent"), new File(root, "server/agent/nthn-agent-cli.ts"));
        } catch (IOException error) {
            Logger.logError("NthnAiInstaller", "Provider tools could not be installed");
        }
    }

    private static void installProotRuntime(File root) throws IOException {
        for (String path : PROOT_RUNTIME) {
            File source = new File(root, "runtime/" + (path.startsWith("lib/") ? "libraries/" + path.substring(4) : path));
            if (!source.isFile()) throw new IOException("proot upgrade asset missing: " + path);
            File target = new File(PREFIX, path);
            if (target.isFile() && (!path.equals("bin/proot") || target.canExecute())) continue;
            File parent = target.getParentFile();
            if (parent == null || (!parent.isDirectory() && !parent.mkdirs())) throw new IOException("proot destination unavailable");
            File temporary = new File(parent, target.getName() + ".nthn-new");
            try (InputStream input = new java.io.FileInputStream(source);
                 FileOutputStream output = new FileOutputStream(temporary, false)) {
                byte[] buffer = new byte[8192]; int count;
                while ((count = input.read(buffer)) != -1) output.write(buffer, 0, count);
                output.getFD().sync();
            }
            if (path.startsWith("bin/") || path.startsWith("libexec/")) {
                if (!temporary.setExecutable(true, false)) throw new IOException("proot executable permission failed");
            }
            if (!temporary.renameTo(target)) throw new IOException("proot upgrade install failed: " + path);
        }
        File loader32 = new File(root, "runtime/libexec/proot/loader32");
        if (loader32.isFile()) {
            File target = new File(PREFIX, "libexec/proot/loader32");
            if (!target.isFile()) {
                try (InputStream input = new java.io.FileInputStream(loader32);
                     FileOutputStream output = new FileOutputStream(target)) {
                    byte[] buffer = new byte[8192]; int count;
                    while ((count = input.read(buffer)) != -1) output.write(buffer, 0, count);
                    output.getFD().sync();
                }
                if (!target.setExecutable(true, false)) throw new IOException("proot loader permission failed");
            }
        }
    }

    private static void installLauncher(File launcher, File entry) throws IOException {
        byte[] script = ("#!" + PREFIX + "/bin/sh\nexec " + PREFIX + "/bin/node --no-warnings " +
            entry.getAbsolutePath() + " \"$@\"\n").getBytes(StandardCharsets.UTF_8);
        try (FileOutputStream out = new FileOutputStream(launcher)) { out.write(script); out.getFD().sync(); }
        if (!launcher.setExecutable(true, true)) throw new IOException("launcher permission");
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
