#if UNITY_EDITOR
using System;
using System.IO;
using System.Linq;
using System.Reflection;
using UnityEditor;
using UnityEditor.Build;
using UnityEditor.Build.Reporting;
using UnityEngine;

// Batchmode build entry for a user's project, used only when the project has no build method or build profile.
// Needs Unity 2021.2 or newer (NamedBuildTarget).
// Copy BOTH this file and EmuLab.Editor.asmdef into Assets/EmuLab/Editor/ only after the user agrees, and do not
// commit them (see AGENTS.md). The asmdef makes this an Editor-only assembly: Editor folders inside an asmdef's
// scope are not special, so without it an asmdef at the Assets/ root would pull this file into the player build.
// Use a NEW folder that holds only these two files. Never put them in an existing folder with scripts such as
// Assets/Editor/: an .asmdef takes every script in its folder and subfolders, so the project's own editor scripts
// would lose their references and stop compiling. To remove it afterwards, delete Assets/EmuLab (and Assets/EmuLab.meta).
// It builds the scenes enabled in Build Settings with the project's current settings, and creates no assets and no
// scene list. For an Android build it needs one installable APK at -buildOut, so for that build only it turns off
// Build App Bundle, Export Project and Split APKs by target architecture.
//   -executeMethod EmuProjectBuild.BuildApk   -buildOut <file.apk>  [-release] [-emuArm64]
//   -executeMethod EmuProjectBuild.BuildWebGL -buildOut <folder>    [-release]
//   -executeMethod EmuProjectBuild.BuildWindows -buildOut <file.exe> [-release]   (StandaloneWindows64)
// -emuArm64 (Android, opt-in): for this build only use IL2CPP + ARM64, which the x86_64 emulator can run
// (Mono builds are ARMv7 only).
// Windows: for this build only it turns on Disable Unity Audio (Project Settings > Audio; the player runs on the
// person's desktop and has no mute switch of its own), Run In Background (the player keeps running while its window
// has no focus) and Use Player Log (the smoke test reads Player.log). An EMU_BUILD_NOTE line says so: report it as a
// muted test build, a different binary from a release build. The project's Windows scripting backend is kept: an
// IL2CPP project needs the Windows Build Support (IL2CPP) module and Visual Studio with C++ (doctor.ps1 -Target Windows).
// Custom keystore (Android): Unity does not save keystore passwords to disk, so a fresh batchmode Unity cannot sign
// with the release keystore. When the passwords are not set, this test APK is signed with the debug keystore and an
// EMU_BUILD_WARN line says so. Never put keystore passwords on the command line for this.
// Addressables: this file does not build Addressables content and does not need the package. When the package is
// installed and content is not built with the player, an EMU_BUILD_WARN line says the content must be built first.
// Every setting it changes is restored in a finally block, also when the build fails or throws (ProjectSettings.asset
// is saved again). A Unity that is killed (timeout, Stop-Process) cannot restore them: run project-guard Report.
public static class EmuProjectBuild
{
    public static void BuildApk() { Build(BuildTarget.Android, BuildTargetGroup.Android); }
    public static void BuildWebGL() { Build(BuildTarget.WebGL, BuildTargetGroup.WebGL); }
    public static void BuildWindows() { Build(BuildTarget.StandaloneWindows64, BuildTargetGroup.Standalone); }

    const string AudioManagerPath = "ProjectSettings/AudioManager.asset";

    static void Build(BuildTarget target, BuildTargetGroup group)
    {
        bool ok = false;
        bool android = target == BuildTarget.Android;
        bool windows = target == BuildTarget.StandaloneWindows64;
        bool arm64 = android && HasArg("-emuArm64");
        // EditorUserBuildSettings are stored in Library/. PlayerSettings are in ProjectSettings.asset, which
        // BuildPlayer saves to disk, so those are restored and saved again below.
        bool savedAab = EditorUserBuildSettings.buildAppBundle;
        bool savedExport = EditorUserBuildSettings.exportAsGoogleAndroidProject;
        bool savedSplit = PlayerSettings.Android.buildApkPerCpuArchitecture;
        bool savedCustomKeystore = PlayerSettings.Android.useCustomKeystore;
        var savedBackend = PlayerSettings.GetScriptingBackend(NamedBuildTarget.Android);
        var savedArch = PlayerSettings.Android.targetArchitectures;
        bool savedRunInBackground = PlayerSettings.runInBackground;
        bool savedPlayerLog = PlayerSettings.usePlayerLog;
        bool changedSplit = false, changedKeystore = false, changedAudio = false, changedRun = false, changedLog = false;
        try
        {
            string outPath = GetArg("-buildOut");
            if (string.IsNullOrEmpty(outPath)) throw new ArgumentException("-buildOut <path> is required");
            string[] scenes = EditorBuildSettings.scenes.Where(s => s.enabled).Select(s => s.path).ToArray();
            if (scenes.Length == 0) throw new InvalidOperationException("No enabled scene in Build Settings; ask the user which scenes to build.");

            string full = Path.GetFullPath(outPath);
            if (android && !full.EndsWith(".apk", StringComparison.OrdinalIgnoreCase))
                throw new ArgumentException("-buildOut must be an .apk file for Android: " + full);
            if (windows && !full.EndsWith(".exe", StringComparison.OrdinalIgnoreCase))
                throw new ArgumentException("-buildOut must be an .exe file for Windows: " + full);
            Directory.CreateDirectory(android || windows ? Path.GetDirectoryName(full) : full);
            if (android)
            {
                // The smoke test installs one universal .apk from -buildOut.
                EditorUserBuildSettings.buildAppBundle = false;
                if (savedExport)
                {
                    EditorUserBuildSettings.exportAsGoogleAndroidProject = false;
                    Debug.Log("EMU_BUILD_NOTE Export Project is off for this build (an APK, not a Gradle project folder).");
                }
                if (savedSplit)
                {
                    PlayerSettings.Android.buildApkPerCpuArchitecture = false;
                    changedSplit = true;
                    Debug.Log("EMU_BUILD_NOTE Split APKs by target architecture is off for this build (one universal APK).");
                }
                if (savedCustomKeystore && !HasKeystorePasswords())
                {
                    PlayerSettings.Android.useCustomKeystore = false;
                    changedKeystore = true;
                    Debug.LogWarning("EMU_BUILD_WARN Custom keystore is on, but its passwords are not set in this batchmode Unity " +
                        "(Unity does not save them), so this test APK is signed with the debug keystore. Report it as a debug-signed " +
                        "test build; the keystore setting is restored after the build.");
                }
            }
            if (arm64)
            {
                PlayerSettings.SetScriptingBackend(NamedBuildTarget.Android, ScriptingImplementation.IL2CPP);
                PlayerSettings.Android.targetArchitectures = AndroidArchitecture.ARM64;
            }
            if (windows)
            {
                // The player runs on the person's own desktop: keep it silent (AGENTS.md rule 4).
                bool? audioOff = GetDisableAudio();
                if (audioOff == true)
                {
                    Debug.Log("EMU_BUILD_NOTE audio-off: the project already has Disable Unity Audio on.");
                }
                else if (audioOff == false)
                {
                    SetDisableAudio(true);
                    changedAudio = true;
                    Debug.Log("EMU_BUILD_NOTE audio-off: Disable Unity Audio is on for this test build only (restored afterwards), " +
                        "so this player is a muted test build, a different binary from a release build.");
                }
                else
                {
                    Debug.LogWarning("EMU_BUILD_WARN could not read Disable Unity Audio in " + AudioManagerPath + "; this build may play sound.");
                }
                if (!savedRunInBackground)
                {
                    PlayerSettings.runInBackground = true;
                    changedRun = true;
                    Debug.Log("EMU_BUILD_NOTE Run In Background is on for this test build only, so the player keeps running while its window has no focus.");
                }
                if (!savedPlayerLog)
                {
                    PlayerSettings.usePlayerLog = true;
                    changedLog = true;
                    Debug.Log("EMU_BUILD_NOTE Use Player Log is on for this test build only (the smoke test reads Player.log).");
                }
            }
            WarnAddressables(target);

            var report = BuildPipeline.BuildPlayer(new BuildPlayerOptions
            {
                scenes = scenes,
                locationPathName = full,
                target = target,
                targetGroup = group,
                options = HasArg("-release") ? BuildOptions.None : BuildOptions.Development,
            });
            var s = report.summary;
            Debug.Log($"EMU_BUILD_RESULT {s.result} target={target} errors={s.totalErrors} size={s.totalSize} time={s.totalTime} out={full}");
            ok = s.result == BuildResult.Succeeded;
        }
        catch (Exception e)
        {
            Debug.LogError("EMU_BUILD_RESULT Exception " + e);
        }
        finally
        {
            // Each step on its own, so one failure does not skip the rest.
            Restore("Build App Bundle", () => EditorUserBuildSettings.buildAppBundle = savedAab);
            if (android && savedExport)
                Restore("Export Project", () => EditorUserBuildSettings.exportAsGoogleAndroidProject = savedExport);
            if (changedSplit)
                Restore("Split APKs by target architecture", () => PlayerSettings.Android.buildApkPerCpuArchitecture = savedSplit);
            if (changedKeystore)
                Restore("custom keystore", () => PlayerSettings.Android.useCustomKeystore = savedCustomKeystore);
            if (arm64)
            {
                Restore("scripting backend", () => PlayerSettings.SetScriptingBackend(NamedBuildTarget.Android, savedBackend));
                Restore("target architectures", () => PlayerSettings.Android.targetArchitectures = savedArch);
            }
            if (changedAudio)
                Restore("Disable Unity Audio", () => SetDisableAudio(false));
            if (changedRun)
                Restore("Run In Background", () => PlayerSettings.runInBackground = savedRunInBackground);
            if (changedLog)
                Restore("Use Player Log", () => PlayerSettings.usePlayerLog = savedPlayerLog);
            if (arm64 || changedSplit || changedKeystore || changedAudio || changedRun || changedLog)
                Restore("ProjectSettings", () => AssetDatabase.SaveAssets()); // write the restored values back to disk
        }
        if (!ok) EditorApplication.Exit(1);
    }

    static void Restore(string what, Action restore)
    {
        try { restore(); }
        catch (Exception e)
        {
            Debug.LogError("EMU_BUILD_WARN could not restore " + what + " (" + e.Message + "); run project-guard Report and tell the user.");
        }
    }

    // Project Settings > Audio > Disable Unity Audio has no PlayerSettings API: it is m_DisableAudio of the
    // AudioManager settings object. null when it cannot be read.
    static SerializedObject LoadAudioManager()
    {
        var objects = AssetDatabase.LoadAllAssetsAtPath(AudioManagerPath);
        return objects != null && objects.Length > 0 && objects[0] != null ? new SerializedObject(objects[0]) : null;
    }

    static bool? GetDisableAudio()
    {
        try
        {
            var property = LoadAudioManager()?.FindProperty("m_DisableAudio");
            return property == null ? (bool?)null : property.boolValue;
        }
        catch (Exception e)
        {
            Debug.LogWarning("EMU_BUILD_WARN reading Disable Unity Audio failed: " + e.Message);
            return null;
        }
    }

    static void SetDisableAudio(bool value)
    {
        var settings = LoadAudioManager();
        var property = settings?.FindProperty("m_DisableAudio");
        if (property == null) throw new InvalidOperationException("m_DisableAudio not found in " + AudioManagerPath);
        property.boolValue = value;
        settings.ApplyModifiedPropertiesWithoutUndo();
    }

    // Unity keeps the keystore and key alias passwords in memory only, so a batchmode Unity has none unless a
    // project editor script sets them (for example from environment variables).
    static bool HasKeystorePasswords()
    {
        return !string.IsNullOrEmpty(PlayerSettings.Android.keystorePass)
            && !string.IsNullOrEmpty(PlayerSettings.Android.keyaliasName)
            && !string.IsNullOrEmpty(PlayerSettings.Android.keyaliasPass);
    }

    // Addressables is found by reflection, so this file compiles with or without the package. BuildPlayer packs
    // the content last built for the target unless "Build Addressables on Player Build" builds it now.
    static void WarnAddressables(BuildTarget target)
    {
        try
        {
            Type settingsType = FindType("UnityEditor.AddressableAssets.Settings.AddressableAssetSettings");
            if (settingsType == null) return; // package not installed
            Type defaultObject = settingsType.Assembly.GetType("UnityEditor.AddressableAssets.AddressableAssetSettingsDefaultObject", false);
            PropertyInfo settingsProp = defaultObject == null ? null : defaultObject.GetProperty("Settings", BindingFlags.Public | BindingFlags.Static);
            object settings = settingsProp == null ? null : settingsProp.GetValue(null, null);
            if (settings == null) return; // package installed but no Addressables settings asset: nothing to build

            // AddressableAssetSettings.BuildAddressablesWithPlayerBuild (Addressables 1.19+):
            // PreferencesValue (Edit > Preferences > Addressables, default on), BuildWithPlayer or DoNotBuildWithPlayer.
            bool? withPlayer = null;
            PropertyInfo option = settingsType.GetProperty("BuildAddressablesWithPlayerBuild", BindingFlags.Public | BindingFlags.Instance);
            if (option != null)
            {
                string value = Convert.ToString(option.GetValue(settings, null));
                if (value == "BuildWithPlayer") withPlayer = true;
                else if (value == "DoNotBuildWithPlayer") withPlayer = false;
                else if (value == "PreferencesValue") withPlayer = EditorPrefs.GetBool(AddressablesPreferenceKey(settingsType.Assembly), true);
            }
            if (withPlayer == true)
            {
                Debug.Log("EMU_BUILD_NOTE Addressables content is built with this player build (Build Addressables on Player Build).");
                return;
            }
            string why = withPlayer == false
                ? "'Build Addressables on Player Build' is off"
                : "this Addressables version does not say whether it builds content with the player";
            Debug.LogWarning($"EMU_BUILD_WARN Addressables: {why}, so the build packs the content last built for {target}; " +
                "missing or stale content fails at runtime. With the user's consent build the Addressables content for " +
                $"{target} first (Addressables Groups > Build > New Build), then build again.");
        }
        catch (Exception e)
        {
            Debug.LogWarning($"EMU_BUILD_WARN Addressables check failed ({e.Message}); make sure Addressables content for {target} is built before testing.");
        }
    }

    static string AddressablesPreferenceKey(Assembly addressables)
    {
        // Internal constant AddressablesPreferences.kBuildAddressablesWithPlayerBuildKey; the literal is its value.
        const string fallback = "Addressables.BuildAddressablesWithPlayerBuild";
        Type prefs = addressables.GetType("UnityEditor.AddressableAssets.AddressablesPreferences", false);
        FieldInfo field = prefs == null ? null : prefs.GetField("kBuildAddressablesWithPlayerBuildKey",
            BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);
        string key = field == null ? null : field.GetValue(null) as string;
        return string.IsNullOrEmpty(key) ? fallback : key;
    }

    static Type FindType(string fullName)
    {
        foreach (var assembly in AppDomain.CurrentDomain.GetAssemblies())
        {
            Type t = assembly.GetType(fullName, false);
            if (t != null) return t;
        }
        return null;
    }

    static bool HasArg(string name) => Array.IndexOf(Environment.GetCommandLineArgs(), name) >= 0;

    static string GetArg(string name)
    {
        var args = Environment.GetCommandLineArgs();
        for (int i = 0; i < args.Length - 1; i++)
            if (args[i] == name) return args[i + 1];
        return null;
    }
}
#endif
