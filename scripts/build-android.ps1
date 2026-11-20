# Android shortcut for build-unity.ps1 (kept so existing commands keep working).
#
#   build-android.ps1 -ProjectPath sample\EmuSmoke -Method EmuBuild.BuildApk
#   build-android.ps1 -ProjectPath <p> -Method EmuProjectBuild.BuildApk -EmuArm64
#   build-android.ps1 -ProjectPath <p> -BuildProfile "Assets/Settings/Build Profiles/Android.asset"
param(
    [Parameter(Mandatory)] [string]$ProjectPath,
    [string]$Method,
    [string]$BuildProfile,
    [string]$Out,
    [int]$TimeoutMinutes = 40,
    [switch]$EmuArm64
)
# build-unity.ps1 throws on any failure, so reaching the next line means success.
& "$PSScriptRoot\build-unity.ps1" -Target Android @PSBoundParameters
exit 0
