using System;
using System.Collections;
using UnityEngine;
using UnityEngine.Diagnostics;
#if UNITY_ANDROID
using Unity.Notifications.Android;
#endif

// Smoke-test app for the emulator, browser and Windows pipelines.
// Every check the outside harness relies on is a "SMOKE_*" line in the Unity log: logcat (tag Unity) on Android,
// the browser console on WebGL, Player.log (-logFile) on Windows.
// Windows player only: "-emuSmokeFault crash|exception|quit" makes the app fail on purpose one second after
// SMOKE_APP_READY (native crash, unhandled C# exception, Application.Quit(3)), so the smoke test's FAIL checks can be
// tried; SMOKE_AUDIO logs whether Unity audio runs (dsp_time stays 0 when it is disabled).
public class EmuSmoke : MonoBehaviour
{
    const string ChannelId = "emu_smoke";

    int taps;
    string status = "starting";
    string notifLine = "-";
    int lastOpenedId = -1;
    GUIStyle label, button;

    IEnumerator Start()
    {
        Application.targetFrameRate = 60;
        Debug.Log("SMOKE_APP_STARTED");
#if UNITY_ANDROID && !UNITY_EDITOR
        AndroidNotificationCenter.RegisterNotificationChannel(new AndroidNotificationChannel(
            ChannelId, "Emu Smoke", "Emulator smoke test", Importance.High));

        bool openedFromNotification = CheckOpenedFromNotification();

        var request = new PermissionRequest();
        while (request.Status == PermissionStatus.RequestPending)
            yield return null;
        Debug.Log($"SMOKE_NOTIF_PERMISSION {request.Status}");

        int delay = ReadIntExtra("notif_delay", 20);
        if (!openedFromNotification && delay > 0)
            Schedule(delay);
#endif
        status = "ready";
        Debug.Log("SMOKE_APP_READY");
#if UNITY_STANDALONE && !UNITY_EDITOR
        StartCoroutine(LogAudio());
        string fault = ReadArg("-emuSmokeFault");
        if (!string.IsNullOrEmpty(fault)) StartCoroutine(Fault(fault));
#endif
        yield break;
    }

#if UNITY_STANDALONE && !UNITY_EDITOR
    static IEnumerator LogAudio()
    {
        yield return new WaitForSecondsRealtime(1f);
        // dspTime only: AudioSettings.outputSampleRate logs an error when audio is disabled.
        Debug.Log($"SMOKE_AUDIO dsp_time={AudioSettings.dspTime:F3}");
    }

    IEnumerator Fault(string kind)
    {
        yield return new WaitForSecondsRealtime(1f);
        Debug.Log($"SMOKE_FAULT {kind}");
        switch (kind)
        {
            case "crash": Utils.ForceCrash(ForcedCrashCategory.AccessViolation); break;
            case "exception": throw new InvalidOperationException("SMOKE_FAULT unhandled exception on purpose");
            case "quit": Application.Quit(3); break;
            default: Debug.LogWarning($"SMOKE_FAULT unknown kind '{kind}' (crash, exception, quit)"); break;
        }
    }

    static string ReadArg(string name)
    {
        var args = Environment.GetCommandLineArgs();
        for (int i = 0; i < args.Length - 1; i++)
            if (args[i] == name) return args[i + 1];
        return null;
    }
#endif

    void OnApplicationFocus(bool focus)
    {
#if UNITY_ANDROID && !UNITY_EDITOR
        if (focus) CheckOpenedFromNotification();
#endif
    }

#if UNITY_ANDROID && !UNITY_EDITOR
    bool CheckOpenedFromNotification()
    {
        var intent = AndroidNotificationCenter.GetLastNotificationIntent();
        if (intent == null || intent.Id == lastOpenedId) return intent != null;
        lastOpenedId = intent.Id;
        notifLine = "opened from: " + intent.Notification.Title;
        Debug.Log($"SMOKE_OPENED_FROM_NOTIFICATION id={intent.Id} title={intent.Notification.Title}");
        return true;
    }

    void Schedule(int seconds)
    {
        string title = "EMU-SMOKE-" + DateTime.Now.ToString("HHmmss");
        var notification = new AndroidNotification
        {
            Title = title,
            Text = $"Local notification scheduled {seconds}s ahead",
            FireTime = DateTime.Now.AddSeconds(seconds),
        };
        int id = AndroidNotificationCenter.SendNotification(notification, ChannelId);
        notifLine = $"scheduled {title} (+{seconds}s)";
        Debug.Log($"SMOKE_NOTIF_SCHEDULED id={id} title={title} delay={seconds} exact={AndroidNotificationCenter.UsingExactScheduling}");
    }

    // Reads an "am start --es <key> <value>" extra so the harness can pick the delay.
    static int ReadIntExtra(string key, int fallback)
    {
        try
        {
            using var player = new AndroidJavaClass("com.unity3d.player.UnityPlayer");
            using var activity = player.GetStatic<AndroidJavaObject>("currentActivity");
            using var intent = activity.Call<AndroidJavaObject>("getIntent");
            string value = intent?.Call<string>("getStringExtra", key);
            return int.TryParse(value, out int parsed) ? parsed : fallback;
        }
        catch (Exception e)
        {
            Debug.LogWarning($"SMOKE_EXTRA_READ_FAILED {key}: {e.Message}");
            return fallback;
        }
    }
#endif

    void OnGUI()
    {
        if (label == null)
        {
            int size = Mathf.Max(24, Screen.height / 40);
            label = new GUIStyle(GUI.skin.label) { fontSize = size, wordWrap = true };
            label.normal.textColor = Color.white;
            button = new GUIStyle(GUI.skin.button) { fontSize = size * 2 };
        }

        float w = Screen.width, h = Screen.height, pad = w * 0.05f;
        GUI.Label(new Rect(pad, h * 0.06f, w - pad * 2, h * 0.06f), "EMU SMOKE", label);
        GUI.Label(new Rect(pad, h * 0.12f, w - pad * 2, h * 0.06f), "status: " + status, label);
        GUI.Label(new Rect(pad, h * 0.18f, w - pad * 2, h * 0.06f), "taps: " + taps, label);
        GUI.Label(new Rect(pad, h * 0.24f, w - pad * 2, h * 0.12f), "notif: " + notifLine, label);

        // Center of the screen is the tap target the harness hits with "adb shell input tap".
        if (GUI.Button(new Rect(w * 0.2f, h * 0.4f, w * 0.6f, h * 0.2f), "TAP", button))
        {
            taps++;
            Debug.Log($"SMOKE_TAP count={taps}");
        }
#if UNITY_ANDROID && !UNITY_EDITOR
        if (GUI.Button(new Rect(w * 0.2f, h * 0.68f, w * 0.6f, h * 0.1f), "notify in 10s", button))
            Schedule(10);
#endif
    }
}
