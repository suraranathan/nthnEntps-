package com.termux.app;

import android.content.Context;

import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.Comparator;
import java.util.List;

final class NthnBackend {
    static final String PREFIX = "/data/data/com.nthn/files/usr";
    private static final int MAX_TEXT_FILE_BYTES = 1024 * 1024;

    static final class EnvironmentStatus {
        final boolean ready;
        final boolean nodeReady;
        final long freeBytes;
        final String homePath;

        EnvironmentStatus(boolean ready, boolean nodeReady, long freeBytes, String homePath) {
            this.ready = ready;
            this.nodeReady = nodeReady;
            this.freeBytes = freeBytes;
            this.homePath = homePath;
        }
    }

    static final class CommandResult {
        final int exitCode;
        final String output;

        CommandResult(int exitCode, String output) {
            this.exitCode = exitCode;
            this.output = output.trim();
        }

        boolean ok() { return exitCode == 0; }
    }

    private final Context context;
    private final File home;
    private Process activeProcess;

    NthnBackend(Context context) throws IOException {
        this.context = context.getApplicationContext();
        home = new File(this.context.getFilesDir(), "home").getCanonicalFile();
        if (!home.exists() && !home.mkdirs()) throw new IOException("Home directory is unavailable");
    }

    EnvironmentStatus environmentStatus() {
        File shell = new File(PREFIX, "bin/sh");
        File node = new File(PREFIX, "bin/node");
        return new EnvironmentStatus(shell.isFile() && shell.canExecute(),
            node.isFile() && node.canExecute(), context.getFilesDir().getUsableSpace(), home.getAbsolutePath());
    }

    File home() { return home; }

    File resolve(File directory, String name) throws IOException {
        if (name == null || name.trim().isEmpty() || name.contains("/"))
            throw new IOException("Enter a valid name");
        return confine(new File(directory, name.trim()));
    }

    File confine(File file) throws IOException {
        File canonical = file.getCanonicalFile();
        String root = home.getPath();
        if (!canonical.getPath().equals(root) && !canonical.getPath().startsWith(root + File.separator))
            throw new IOException("That path is outside NTHN home");
        return canonical;
    }

    List<File> listFiles(File directory) throws IOException {
        File safe = confine(directory);
        File[] files = safe.listFiles();
        if (files == null) throw new IOException("This directory cannot be read");
        List<File> result = new ArrayList<>(Arrays.asList(files));
        Collections.sort(result, new Comparator<File>() {
            @Override public int compare(File left, File right) {
                if (left.isDirectory() != right.isDirectory()) return left.isDirectory() ? -1 : 1;
                return left.getName().compareToIgnoreCase(right.getName());
            }
        });
        return result;
    }

    void createFile(File directory, String name, boolean folder) throws IOException {
        File target = resolve(directory, name);
        if (target.exists()) throw new IOException("A file with that name already exists");
        boolean created = folder ? target.mkdir() : target.createNewFile();
        if (!created) throw new IOException("Could not create " + name);
    }

    void rename(File source, String newName) throws IOException {
        File safe = confine(source);
        File target = resolve(safe.getParentFile(), newName);
        if (target.exists()) throw new IOException("A file with that name already exists");
        if (!safe.renameTo(target)) throw new IOException("Could not rename " + safe.getName());
    }

    void delete(File source) throws IOException {
        File safe = confine(source);
        if (safe.equals(home)) throw new IOException("NTHN home cannot be deleted");
        if (safe.isDirectory()) {
            File[] children = safe.listFiles();
            if (children == null) throw new IOException("This directory cannot be read");
            if (children.length > 0) throw new IOException("The directory must be empty");
        }
        if (!safe.delete()) throw new IOException("Could not delete " + safe.getName());
    }

    String readText(File source) throws IOException {
        File safe = confine(source);
        if (!safe.isFile()) throw new IOException("This is not a file");
        if (safe.length() > MAX_TEXT_FILE_BYTES) throw new IOException("Files larger than 1 MB cannot be edited here");
        ByteArrayOutputStream bytes = new ByteArrayOutputStream((int) safe.length());
        try (InputStream input = new FileInputStream(safe)) {
            byte[] buffer = new byte[8192];
            int count;
            while ((count = input.read(buffer)) != -1) bytes.write(buffer, 0, count);
        }
        byte[] data = bytes.toByteArray();
        for (byte value : data) if (value == 0) throw new IOException("Binary files cannot be edited here");
        return new String(data, StandardCharsets.UTF_8);
    }

    void writeText(File target, String content) throws IOException {
        File safe = confine(target);
        try (FileOutputStream output = new FileOutputStream(safe, false)) {
            output.write(content.getBytes(StandardCharsets.UTF_8));
            output.getFD().sync();
        }
    }

    synchronized CommandResult ai(String command, String argument, char[] secret) throws IOException, InterruptedException {
        NthnAiInstaller.install(context);
        File node = new File(PREFIX, "bin/node");
        File script = new File(context.getFilesDir(), "nthn-ai/server/ai/nthn-cli.ts");
        if (!node.canExecute() || !script.isFile()) throw new IOException("AI service is unavailable until Linux setup completes");
        List<String> invocation = new ArrayList<>();
        invocation.add(node.getAbsolutePath());
        invocation.add("--no-warnings");
        invocation.add(script.getAbsolutePath());
        invocation.add(command);
        if (argument != null) invocation.add(argument);
        ProcessBuilder builder = new ProcessBuilder(invocation);
        builder.redirectErrorStream(false);
        activeProcess = builder.start();
        try {
            StringBuilder stdout = new StringBuilder();
            StringBuilder stderr = new StringBuilder();
            IOException[] streamErrors = new IOException[2];
            Thread stdoutReader = collect(activeProcess.getInputStream(), stdout, streamErrors, 0);
            Thread stderrReader = collect(activeProcess.getErrorStream(), stderr, streamErrors, 1);
            stdoutReader.start();
            stderrReader.start();
            try (OutputStream input = activeProcess.getOutputStream()) {
                if (secret != null) input.write(new String(secret).getBytes(StandardCharsets.UTF_8));
            }
            int exitCode = activeProcess.waitFor();
            stdoutReader.join();
            stderrReader.join();
            if (streamErrors[0] != null) throw streamErrors[0];
            if (streamErrors[1] != null) throw streamErrors[1];
            return new CommandResult(exitCode, exitCode == 0 ? stdout.toString() : failureOutput(stdout, stderr));
        } finally {
            activeProcess = null;
            if (secret != null) Arrays.fill(secret, '\0');
        }
    }

    private static Thread collect(final InputStream input, final StringBuilder output,
                                  final IOException[] errors, final int index) {
        return new Thread(() -> {
            try (BufferedReader reader = new BufferedReader(new InputStreamReader(input, StandardCharsets.UTF_8))) {
                String line;
                while ((line = reader.readLine()) != null) {
                    if (output.length() > 0) output.append('\n');
                    output.append(line);
                }
            } catch (IOException error) { errors[index] = error; }
        }, "nthn-ai-output-" + index);
    }

    private static String failureOutput(StringBuilder stdout, StringBuilder stderr) {
        String[] lines = stderr.toString().trim().split("\\r?\\n");
        for (int index = lines.length - 1; index >= 0; index--) {
            String line = lines[index].trim();
            if (line.startsWith("{") && line.endsWith("}")) return line;
        }
        String error = stderr.toString().trim();
        return error.isEmpty() ? stdout.toString() : error;
    }

    synchronized void stop() {
        if (activeProcess != null) activeProcess.destroy();
    }
}
