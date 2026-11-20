using System;
using System.Collections;
using UnityEngine;
#if UNITY_ANDROID
using Unity.Notifications.Android;
#endif

// Smoke-test app for the emulator pipeline.
// Every check the outside harness relies on is a "SMOKE_*" line in logcat (tag Unity).
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
        yield break;
    }

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
