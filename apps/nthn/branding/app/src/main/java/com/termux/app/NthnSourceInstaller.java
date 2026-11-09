package com.termux.app;

import android.content.Context;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/** Installs an editable source snapshot once; later app updates never replace project edits. */
final class NthnSourceInstaller {
    private static final long MAX_BYTES = 20L * 1024 * 1024;
    private static final int MAX_ENTRIES = 10000;

    static void install(Context context) throws IOException {
        File home = new File(context.getFilesDir(), "home");
        File project = new File(home, "nthnEntps");
        if (project.exists()) return;
        if (!home.isDirectory() && !home.mkdirs()) throw new IOException("Linux home unavailable");

        File staging = File.createTempFile(".nthn-source-", ".tmp", home);
        if (!staging.delete() || !staging.mkdir()) throw new IOException("Source staging unavailable");
        try {
            extract(context, staging);
            if (!new File(staging, "apps/nthn/VERSION").isFile() ||
                !new File(staging, "apps/dashboard/server/agent/agent.ts").isFile()) {
                throw new IOException("Source archive is incomplete");
            }
            if (!staging.renameTo(project)) throw new IOException("Source project could not be installed");
        } finally {
            if (staging.exists()) deleteTree(staging);
        }
    }

    private static void extract(Context context, File staging) throws IOException {
        String root = staging.getCanonicalPath() + File.separator;
        long bytes = 0;
        int entries = 0;
        try (InputStream asset = context.getAssets().open("nthn-source.zip");
             ZipInputStream zip = new ZipInputStream(asset)) {
            ZipEntry entry;
            byte[] buffer = new byte[8192];
            while ((entry = zip.getNextEntry()) != null) {
                if (++entries > MAX_ENTRIES) throw new IOException("Source archive has too many entries");
                String name = entry.getName();
                if (name.startsWith("/") || name.contains("\\") || name.indexOf('\0') >= 0)
                    throw new IOException("Invalid source path");
                for (String part : name.split("/")) {
                    if (part.equals("..") || part.equals(".")) throw new IOException("Invalid source path");
                }
                File target = new File(staging, name);
                if (!target.getCanonicalPath().startsWith(root)) throw new IOException("Source path escapes project");
                if (entry.isDirectory()) {
                    if (!target.isDirectory() && !target.mkdirs()) throw new IOException("Source directory unavailable");
                } else {
                    File parent = target.getParentFile();
                    if (parent == null || (!parent.isDirectory() && !parent.mkdirs()))
                        throw new IOException("Source directory unavailable");
                    try (FileOutputStream output = new FileOutputStream(target)) {
                        int count;
                        while ((count = zip.read(buffer)) != -1) {
                            bytes += count;
                            if (bytes > MAX_BYTES) throw new IOException("Source archive is too large");
                            output.write(buffer, 0, count);
                        }
                    }
                }
                zip.closeEntry();
            }
        }
    }

    private static void deleteTree(File file) {
        File[] children = file.listFiles();
        if (children != null) for (File child : children) deleteTree(child);
        file.delete();
    }
}
