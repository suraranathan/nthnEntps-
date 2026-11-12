package com.termux.app;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.net.Uri;
import android.os.Bundle;
import android.provider.MediaStore;
import android.provider.OpenableColumns;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.speech.tts.TextToSpeech;

import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import androidx.core.content.FileProvider;

import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Locale;

/** Permission-gated native device input used only after an explicit action in Jef's UI. */
final class NthnDeviceController {
    interface Events { void deliver(String kind, String value); }

    private static final int CAMERA_REQUEST = 6101;
    private static final int FILE_REQUEST = 6102;
    private static final int CAMERA_PERMISSION = 6201;
    private static final int AUDIO_PERMISSION = 6202;
    private static final int LOCATION_PERMISSION = 6203;

    private final NthnActivity activity;
    private final TextToSpeech voice;
    private Events events;
    private SpeechRecognizer recognizer;
    private boolean speechCancelled;
    private File pendingCamera;

    NthnDeviceController(NthnActivity activity) {
        this.activity = activity;
        this.voice = new TextToSpeech(activity, status -> { });
    }

    void captureCamera(Events events) {
        this.events = events;
        if (ContextCompat.checkSelfPermission(activity, Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(activity, new String[]{ Manifest.permission.CAMERA }, CAMERA_PERMISSION);
            return;
        }
        launchCamera();
    }

    private void launchCamera() {
        try {
            File directory = new File(activity.getFilesDir(), "home/NTHN-Captures");
            if (!directory.isDirectory() && !directory.mkdirs()) throw new Exception("Capture directory unavailable.");
            pendingCamera = new File(directory, "camera-" + System.currentTimeMillis() + ".jpg");
            Uri output = FileProvider.getUriForFile(activity, activity.getPackageName() + ".nthnupdates", pendingCamera);
            Intent intent = new Intent(MediaStore.ACTION_IMAGE_CAPTURE)
                .putExtra(MediaStore.EXTRA_OUTPUT, output)
                .addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_READ_URI_PERMISSION);
            activity.startActivityForResult(intent, CAMERA_REQUEST);
        } catch (Exception error) { deliverError("Camera is unavailable."); }
    }

    void listen(Events events) {
        this.events = events;
        if (ContextCompat.checkSelfPermission(activity, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(activity, new String[]{ Manifest.permission.RECORD_AUDIO }, AUDIO_PERMISSION);
            return;
        }
        startListening();
    }

    void stopListening(Events events) {
        this.events = events;
        if (recognizer != null) {
            speechCancelled = true;
            recognizer.cancel();
            recognizer.destroy();
            recognizer = null;
        }
        deliver("status", "Listening stopped.");
    }

    private void startListening() {
        if (!SpeechRecognizer.isRecognitionAvailable(activity)) { deliverError("Speech recognition is unavailable."); return; }
        speechCancelled = false;
        if (recognizer != null) recognizer.destroy();
        recognizer = SpeechRecognizer.createSpeechRecognizer(activity);
        recognizer.setRecognitionListener(new RecognitionListener() {
            @Override public void onReadyForSpeech(Bundle params) { deliver("status", "Listening…"); }
            @Override public void onBeginningOfSpeech() { }
            @Override public void onRmsChanged(float rmsdB) { }
            @Override public void onBufferReceived(byte[] buffer) { }
            @Override public void onEndOfSpeech() { }
            @Override public void onError(int error) {
                boolean cancelled = speechCancelled;
                speechCancelled = false;
                finishListening();
                if (!cancelled) deliverError("Speech recognition stopped (code " + error + ").");
            }
            @Override public void onResults(Bundle results) {
                ArrayList<String> values = results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
                finishListening();
                if (values == null || values.isEmpty()) { deliverError("No speech was recognized."); return; }
                String text = values.get(0);
                record(new JSONObject(), "speech", text, null);
                deliver("speech", text);
            }
            @Override public void onPartialResults(Bundle partialResults) { }
            @Override public void onEvent(int eventType, Bundle params) { }
        });
        Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
            .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            .putExtra(RecognizerIntent.EXTRA_LANGUAGE, Locale.getDefault().toLanguageTag())
            .putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1);
        recognizer.startListening(intent);
    }

    private void finishListening() {
        if (recognizer != null) {
            recognizer.destroy();
            recognizer = null;
        }
    }

    void locate(Events events) {
        this.events = events;
        if (ContextCompat.checkSelfPermission(activity, Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED &&
            ContextCompat.checkSelfPermission(activity, Manifest.permission.ACCESS_COARSE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(activity, new String[]{ Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION }, LOCATION_PERMISSION);
            return;
        }
        readLocation();
    }

    private void readLocation() {
        try {
            LocationManager manager = (LocationManager) activity.getSystemService(Activity.LOCATION_SERVICE);
            Location location = manager.getLastKnownLocation(LocationManager.GPS_PROVIDER);
            if (location == null) location = manager.getLastKnownLocation(LocationManager.NETWORK_PROVIDER);
            if (location != null) { deliverLocation(location); return; }
            String provider = manager.isProviderEnabled(LocationManager.NETWORK_PROVIDER) ? LocationManager.NETWORK_PROVIDER : LocationManager.GPS_PROVIDER;
            manager.requestSingleUpdate(provider, new LocationListener() {
                @Override public void onLocationChanged(Location value) { deliverLocation(value); }
                @Override public void onStatusChanged(String provider, int status, Bundle extras) { }
                @Override public void onProviderEnabled(String provider) { }
                @Override public void onProviderDisabled(String provider) { deliverError("Location services are disabled."); }
            }, activity.getMainLooper());
        } catch (Exception error) { deliverError("Location is unavailable."); }
    }

    private void deliverLocation(Location location) {
        try {
            JSONObject state = new JSONObject().put("latitude", location.getLatitude()).put("longitude", location.getLongitude())
                .put("accuracyMeters", location.hasAccuracy() ? location.getAccuracy() : JSONObject.NULL);
            record(state, "location", null, null);
            deliver("device-context", state.put("kind", "location").put("observedAt", Instant.now().toString()).toString());
        } catch (Exception error) { deliverError("Location could not be recorded."); }
    }

    void importFile(Events events) {
        this.events = events;
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*");
        activity.startActivityForResult(intent, FILE_REQUEST);
    }

    void speak(Events events, String text) {
        this.events = events;
        String value = text == null ? "" : text.trim();
        if (value.isEmpty() || value.length() > 4000) { deliverError("Spoken text must be between 1 and 4000 characters."); return; }
        voice.speak(value, TextToSpeech.QUEUE_FLUSH, null, "nthn-jef");
    }

    void onPermissionResult(int requestCode, int[] results) {
        boolean granted = false;
        for (int result : results) if (result == PackageManager.PERMISSION_GRANTED) granted = true;
        if (results.length == 0 || !granted) { deliverError("Android permission was not granted."); return; }
        if (requestCode == CAMERA_PERMISSION) launchCamera();
        else if (requestCode == AUDIO_PERMISSION) startListening();
        else if (requestCode == LOCATION_PERMISSION) readLocation();
    }

    void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (resultCode != Activity.RESULT_OK) return;
        if (requestCode == CAMERA_REQUEST && pendingCamera != null && pendingCamera.isFile() && pendingCamera.length() > 0) {
            try {
                JSONObject state = new JSONObject().put("path", pendingCamera.getAbsolutePath()).put("bytes", pendingCamera.length());
                record(state, "camera", null, pendingCamera);
                deliver("device-context", state.put("kind", "camera").put("observedAt", Instant.now().toString()).toString());
            } catch (Exception error) { deliverError("Camera image could not be recorded."); }
        } else if (requestCode == FILE_REQUEST && data != null && data.getData() != null) importSelectedFile(data.getData());
    }

    private void importSelectedFile(Uri uri) {
        File target = null;
        try {
            String name = "shared-file";
            try (android.database.Cursor cursor = activity.getContentResolver().query(uri, new String[]{ OpenableColumns.DISPLAY_NAME }, null, null, null)) {
                if (cursor != null && cursor.moveToFirst()) name = cursor.getString(0);
            }
            name = name == null ? "shared-file" : name.replaceAll("[^A-Za-z0-9._-]", "_");
            if (name.isEmpty()) name = "shared-file";
            File directory = new File(activity.getFilesDir(), "home/NTHN-Imports");
            if (!directory.isDirectory() && !directory.mkdirs()) throw new Exception("Import directory unavailable.");
            target = new File(directory, System.currentTimeMillis() + "-" + name);
            long bytes = 0;
            try (InputStream input = activity.getContentResolver().openInputStream(uri); FileOutputStream output = new FileOutputStream(target)) {
                if (input == null) throw new Exception("File unavailable.");
                byte[] buffer = new byte[8192]; int count;
                while ((count = input.read(buffer)) != -1) {
                    bytes += count;
                    if (bytes > 50_000_000) throw new Exception("File exceeds 50 MB.");
                    output.write(buffer, 0, count);
                }
                output.getFD().sync();
            }
            JSONObject state = new JSONObject().put("path", target.getAbsolutePath()).put("name", name).put("bytes", bytes);
            record(state, "file", null, target);
            deliver("device-context", state.put("kind", "file").put("observedAt", Instant.now().toString()).toString());
        } catch (Exception error) {
            if (target != null && target.isFile()) target.delete();
            deliverError("Shared file could not be imported.");
        }
    }

    private void record(JSONObject state, String kind, String text, File file) {
        try {
            state.put("kind", kind).put("observedAt", Instant.now().toString());
            if (text != null) state.put("text", text);
            if (file != null) state.put("path", file.getAbsolutePath()).put("bytes", file.length());
            NthnAppState.recordDevice(activity, state);
        } catch (Exception ignored) { }
    }

    private void deliver(String kind, String value) { if (events != null) events.deliver(kind, value); }
    private void deliverError(String value) { deliver("error", value); }

    void destroy() {
        finishListening();
        voice.stop();
        voice.shutdown();
    }
}
