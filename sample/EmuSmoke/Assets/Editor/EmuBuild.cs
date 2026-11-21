using System;
using System.IO;
using UnityEditor;
using UnityEditor.Build;
using UnityEditor.Build.Reporting;
using UnityEditor.SceneManagement;
using UnityEngine;

// Batchmode entry points:
//   Unity.exe -batchmode -quit -projectPath <p> -buildTarget android -executeMethod EmuBuild.BuildApk -buildOut <file.apk>
//   Unity.exe -batchmode -quit -projectPath <p> -buildTarget webgl -executeMethod EmuBuild.BuildWebGL -buildOut <folder>
//             [-webglCompression brotli|gzip|disabled]
//   Unity.exe -batchmode -quit -projectPath <p> -buildTarget win64 -executeMethod EmuBuild.BuildWindows -buildOut <file.exe>
//             [-emuKeepAudio]
// Add -release for a non-development build (WebGL compresses only non-development builds).
// -webglCompression applies to that one build: the project setting is put back afterwards.
// BuildWindows turns on Disable Unity Audio, Run In Background and a windowed default for that one build and puts the
// project settings back afterwards. -emuKeepAudio leaves audio on (the sample plays no sound; it exists to compare the
// SMOKE_AUDIO line of a build with audio against a muted one).
public static class EmuBuild
{
    const string ScenePath = "Assets/Scenes/Main.unity";

    public static void BuildApk()
    {
        Build(BuildTarget.Android, BuildTargetGroup.Android, GetArg("-buildOut") ?? GetArg("-apkOut") ?? "Builds/EmuSmoke.apk", () =>
        {
            PlayerSettings.SetApplicationIdentifier(NamedBuildTarget.Android, "com.example.emusmoke");
            PlayerSettings.SetScriptingBackend(NamedBuildTarget.Android, ScriptingImplementation.IL2CPP);
            PlayerSettings.Android.targetArchitectures = AndroidArchitecture.ARM64;
            EditorUserBuildSettings.buildAppBundle = false;
        });
    }

    public static void BuildWebGL()
    {
        // compressionFormat lives in ProjectSettings.asset, which BuildPlayer saves to disk.
        var savedCompression = PlayerSettings.WebGL.compressionFormat;
        Build(BuildTarget.WebGL, BuildTargetGroup.WebGL, GetArg("-buildOut") ?? "Builds/WebGL", () =>
        {
            switch ((GetArg("-webglCompression") ?? "").ToLowerInvariant())
            {
                case "brotli": PlayerSettings.WebGL.compressionFormat = WebGLCompressionFormat.Brotli; break;
                case "gzip": PlayerSettings.WebGL.compressionFormat = WebGLCompressionFormat.Gzip; break;
                case "disabled": PlayerSettings.WebGL.compressionFormat = WebGLCompressionFormat.Disabled; break;
            }
        }, () =>
        {
            if (PlayerSettings.WebGL.compressionFormat == savedCompression) return;
            PlayerSettings.WebGL.compressionFormat = savedCompression;
            AssetDatabase.SaveAssets();
        });
    }

    public static void BuildWindows()
    {
        bool savedRun = PlayerSettings.runInBackground;
        var savedMode = PlayerSettings.fullScreenMode;
        bool keepAudio = HasArg("-emuKeepAudio");
        bool changedAudio = false;
        Build(BuildTarget.StandaloneWindows64, BuildTargetGroup.Standalone, GetArg("-buildOut") ?? "Builds/Windows/app.exe", () =>
        {
            PlayerSettings.runInBackground = true;
            PlayerSettings.fullScreenMode = FullScreenMode.Windowed;
            if (keepAudio)
            {
                Debug.Log("EMU_BUILD_NOTE -emuKeepAudio: Unity audio stays on in this sample build (it plays no sound).");
            }
            else if (GetDisableAudio())
            {
                Debug.Log("EMU_BUILD_NOTE audio-off: the project already has Disable Unity Audio on.");
            }
            else
            {
                SetDisableAudio(true);
                changedAudio = true;
                Debug.Log("EMU_BUILD_NOTE audio-off: Disable Unity Audio is on for this test build only (restored afterwards), " +
                    "so this player is a muted test build, a different binary from a release build.");
            }
        }, () =>
        {
            bool dirty = changedAudio || PlayerSettings.runInBackground != savedRun || PlayerSettings.fullScreenMode != savedMode;
            if (changedAudio) SetDisableAudio(false);
            PlayerSettings.runInBackground = savedRun;
            PlayerSettings.fullScreenMode = savedMode;
            if (dirty) AssetDatabase.SaveAssets();
        });
    }

    // Disable Unity Audio (Project Settings > Audio) is m_DisableAudio of the AudioManager settings object.
    static SerializedObject LoadAudioManager()
    {
        return new SerializedObject(AssetDatabase.LoadAllAssetsAtPath("ProjectSettings/AudioManager.asset")[0]);
    }

    static bool GetDisableAudio() => LoadAudioManager().FindProperty("m_DisableAudio").boolValue;

    static void SetDisableAudio(bool value)
    {
        var settings = LoadAudioManager();
        settings.FindProperty("m_DisableAudio").boolValue = value;
        settings.ApplyModifiedPropertiesWithoutUndo();
    }

    // restoreSettings runs after the build, also when it fails or throws, and before EditorApplication.Exit
    // (Exit does not return, so a finally around the Build call would not run on failure).
    static void Build(BuildTarget target, BuildTargetGroup group, string outPath, Action platformSettings, Action restoreSettings = null)
    {
        bool succeeded = false;
        try
        {
            try
            {
                EnsureScene();

                PlayerSettings.companyName = "EmuLab";
                PlayerSettings.productName = "EmuSmoke";
                PlayerSettings.defaultInterfaceOrientation = UIOrientation.Portrait;
                platformSettings();

                string full = Path.GetFullPath(outPath);
                Directory.CreateDirectory(target == BuildTarget.WebGL ? full : Path.GetDirectoryName(full));   // .apk / .exe: its folder
                var report = BuildPipeline.BuildPlayer(new BuildPlayerOptions
                {
                    scenes = new[] { ScenePath },
                    locationPathName = outPath,
                    target = target,
                    targetGroup = group,
                    options = HasArg("-release") ? BuildOptions.None : BuildOptions.Development,
                });

                var s = report.summary;
                Debug.Log($"EMU_BUILD_RESULT {s.result} target={target} errors={s.totalErrors} size={s.totalSize} time={s.totalTime} out={outPath}");
                succeeded = s.result == BuildResult.Succeeded;
            }
            finally
            {
                if (restoreSettings != null) restoreSettings();
            }
        }
        catch (Exception e)
        {
            Debug.LogError("EMU_BUILD_RESULT Exception " + e);
            succeeded = false;
        }
        if (!succeeded) EditorApplication.Exit(1);
    }

    static void EnsureScene()
    {
        if (!File.Exists(ScenePath))
        {
            Directory.CreateDirectory(Path.GetDirectoryName(ScenePath));
            var scene = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);

            var cam = new GameObject("Main Camera", typeof(Camera)).GetComponent<Camera>();
            cam.tag = "MainCamera";
            cam.clearFlags = CameraClearFlags.SolidColor;
            cam.backgroundColor = new Color(0.16f, 0.36f, 0.34f);

            new GameObject("EmuSmoke", typeof(EmuSmoke));
            EditorSceneManager.SaveScene(scene, ScenePath);
        }
        EditorBuildSettings.scenes = new[] { new EditorBuildSettingsScene(ScenePath, true) };
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
