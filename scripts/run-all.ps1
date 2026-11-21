# One entry point for people and agents: build -> run -> self-test.
#   Android : boot emulator -> build APK -> smoke-test.ps1 (incl. local notification in the shade)
#   WebGL   : build WebGL folder -> smoke-webgl.ps1 (local server + Chrome/Edge over DevTools)
#   Windows : build Windows exe -> smoke-windows.ps1 (player window on this desktop, Player.log, no tap unless -Tap)
#
#   run-all.ps1                                    # sample project, Android
#   run-all.ps1 -Target WebGL                      # sample project, WebGL
#   run-all.ps1 -ProjectPath <p> -Method EmuProjectBuild.BuildApk -EmuArm64 -ReadyMarker "<log line>" -NoTapCheck -NotifDelay 0
#   run-all.ps1 -SkipBuild -Apk <apk> -ReadyMarker "<log line>" -NoTapCheck -NotifDelay 0
#   run-all.ps1 -Target WebGL -SkipBuild -BuildDir <dir> -ReadyMode Loaded -NoTapCheck
#   run-all.ps1 -Target Windows                    # sample project, Windows
#   run-all.ps1 -Target Windows -ProjectPath <p> -Method EmuProjectBuild.BuildWindows -ReadyMarker "<log line>"
# -Apk / -BuildDir / -Exe are the build output AND what gets tested. Default (Get-DefaultBuildOut, common.ps1): the sample's
#   own Builds\ folder, or artifacts\builds\<project>-<hash>\ in this repo for any other -ProjectPath.
# Build options go to build-unity.ps1: -Method or -BuildProfile (one is required for a project other than the sample),
#   -EmuArm64, -TimeoutMinutes, -Release, -WebGLCompression, -ExtraArgs (an array: only with powershell -Command).
# Test options are passed through to smoke-test.ps1 / smoke-webgl.ps1 / smoke-windows.ps1 when given. An option of the other target,
#   or a build option together with -SkipBuild, is an error (nothing is silently dropped).
param(
    [ValidateSet('Android', 'WebGL', 'Windows')] [string]$Target = 'Android',
    [string]$ProjectPath = (Join-Path (Split-Path -Parent $PSScriptRoot) 'sample\EmuSmoke'),
    [string]$Method,
    [string]$BuildProfile,
    [string[]]$ExtraArgs,
    [int]$TimeoutMinutes,
    [switch]$EmuArm64,
    [switch]$SkipBuild,
    [switch]$Release,
    [string]$WebGLCompression = '',
    [switch]$Headless,
    [string]$Apk,
    [string]$BuildDir,
    # shared test options
    [string]$ReadyMarker,
    [int]$ReadyTimeoutSec,
    [double]$TapX,
    [double]$TapY,
    [string]$TapMarker,
    [switch]$NoTap,
    [switch]$NoTapCheck,
    # Android only
    [string]$Package,
    [int]$NotifDelay,
    [string]$NotifScheduledRegex,
    [string]$OpenedMarker,
    [switch]$NoOpenedMarker,
    [int]$NotifTimeoutSec,
    [int]$TimeTravelMinutes,
    [switch]$AskPermission,
    # WebGL only
    [string]$ReadyMode,
    [string]$ReadyExpression,
    [string]$TapExpression,
    [int]$TapTimeoutSec,
    [int]$TapRetrySec,
    [string]$AfterTapExpression,
    [int]$AfterTapTimeoutSec,
    [int]$SettleSec,
    [string]$FailExpression,
    [string]$InfoExpression,
    [int]$Width,
    [int]$Height,
    [string]$Browser,
    [switch]$NoIsolation,
    [switch]$KeepProfile,
    # Windows only
    [string]$Exe,
    [switch]$Tap,
    [switch]$CleanPrefs,
    [switch]$AllowAudio,
    [switch]$FailOnException,
    [string[]]$ExeArgs
)
$ErrorActionPreference = 'Stop'
# Without [CmdletBinding()] unknown options land in $args; refuse them instead of silently dropping them.
# ([CmdletBinding()] is avoided because PS 5.1 leaves $PSScriptRoot empty in its param defaults under -File.)
if ($args.Count) { throw "Unknown option(s): $($args -join ' ')" }
# powershell -File reads a path ending in \ before its closing quote as a literal quote and swallows what follows.
foreach ($a in 'ProjectPath', 'Apk', 'BuildDir', 'BuildProfile', 'Exe') { if ("$(Get-Variable $a -ValueOnly)" -match '"') { throw ("-$a contains a quote: " + 'remove the trailing backslash from that path (powershell -File reads \" as a literal quote).') } }

# Inside a function $PSBoundParameters would be the function's own; keep the script's.
$bound = $PSBoundParameters
function Get-PassThrough([string[]]$Keys) {
    $h = @{}
    foreach ($k in $Keys) { if ($bound.ContainsKey($k)) { $h[$k] = $bound[$k] } }
    return $h
}
# Every test option goes to all targets except those listed here (the targets it belongs to).
$shared = 'ReadyMarker', 'ReadyTimeoutSec', 'TapX', 'TapY', 'TapMarker', 'NoTap', 'NoTapCheck'
$targetsOf = @{}
foreach ($k in 'Apk', 'EmuArm64', 'Package', 'NotifDelay', 'NotifScheduledRegex', 'OpenedMarker', 'NoOpenedMarker',
    'NotifTimeoutSec', 'TimeTravelMinutes', 'AskPermission') { $targetsOf[$k] = @('Android') }
foreach ($k in 'BuildDir', 'WebGLCompression', 'ReadyMode', 'ReadyExpression', 'TapExpression', 'TapTimeoutSec', 'TapRetrySec',
    'AfterTapExpression', 'AfterTapTimeoutSec', 'FailExpression', 'InfoExpression', 'Browser', 'NoIsolation', 'KeepProfile') { $targetsOf[$k] = @('WebGL') }
foreach ($k in 'Exe', 'Tap', 'CleanPrefs', 'AllowAudio', 'FailOnException', 'ExeArgs') { $targetsOf[$k] = @('Windows') }
foreach ($k in 'Headless', 'NoTap') { $targetsOf[$k] = @('Android', 'WebGL') }   # Windows taps only with -Tap
foreach ($k in 'Width', 'Height', 'SettleSec') { $targetsOf[$k] = @('WebGL', 'Windows') }
$buildOnly = 'Method', 'BuildProfile', 'ExtraArgs', 'TimeoutMinutes', 'EmuArm64', 'Release', 'WebGLCompression'

# Refuse option mixes before anything boots or builds (e.g. a WebGL run that forgot -Target WebGL would
# otherwise smoke the sample APK and could print SMOKE PASS).
$wrong = @($targetsOf.Keys | Where-Object { $bound.ContainsKey($_) -and $targetsOf[$_] -notcontains $Target } | Sort-Object)
if ($wrong) {
    $desc = ($wrong | ForEach-Object { "-$_ (only -Target $($targetsOf[$_] -join '/'))" }) -join ', '
    throw "$($desc): not for this run, which is -Target $Target$(if (-not $bound.ContainsKey('Target')) { ' (the default)' }). Add the right -Target or drop them."
}
if ($SkipBuild) {
    $wrong = @($buildOnly | Where-Object { $bound.ContainsKey($_) })
    if ($wrong) { throw "-SkipBuild does not build, so -$($wrong -join ', -') would have no effect. Drop them, or build without -SkipBuild." }
}
if ($Method -and $BuildProfile) { throw 'Pass -Method or -BuildProfile, not both.' }
if ($EmuArm64 -and $BuildProfile) { throw '-EmuArm64 is passed to the build method as -emuArm64, so it needs -Method (e.g. EmuProjectBuild.BuildApk), not -BuildProfile.' }
if ($bound.ContainsKey('TimeTravelMinutes') -and $TimeTravelMinutes -gt 0 -and $bound.ContainsKey('NotifDelay') -and $NotifDelay -le 0) {
    throw '-TimeTravelMinutes needs the automatic notification check (-NotifDelay > 0). With -NotifDelay 0 use time-travel.ps1 + check-notification.ps1, then time-travel.ps1 -Reset.'
}
if ($NotifScheduledRegex) {
    try { $re = [regex]$NotifScheduledRegex } catch { throw "-NotifScheduledRegex is not a valid regex: $($_.Exception.Message)" }
    if ($re.GetGroupNumbers() -notcontains 1) { throw '-NotifScheduledRegex needs capture group 1 = the notification title, e.g. "Scheduled notification: (.+)".' }
}

. "$PSScriptRoot\common.ps1"

# The project is only needed to build or to find the default build output.
$needProject = (-not $SkipBuild) -or ($Target -eq 'Android' -and -not $Apk) -or ($Target -eq 'WebGL' -and -not $BuildDir) -or
    ($Target -eq 'Windows' -and -not $Exe)
if ($needProject) { $ProjectPath = Remove-TrailingSeparator (Resolve-Path -LiteralPath $ProjectPath).ProviderPath }
if ($Target -eq 'Android' -and -not $Apk) { $Apk = Get-DefaultBuildOut $ProjectPath 'Android' }
if ($Target -eq 'WebGL' -and -not $BuildDir) { $BuildDir = Get-DefaultBuildOut $ProjectPath 'WebGL' }
if ($Target -eq 'Windows' -and -not $Exe) { $Exe = Get-DefaultBuildOut $ProjectPath 'Windows' }

if ($SkipBuild) {
    # Fail before the emulator boots when there is nothing to test.
    if ($Target -eq 'Android' -and -not (Test-Path -LiteralPath $Apk -PathType Leaf)) {
        throw "No APK at $Apk$(if (-not $bound.ContainsKey('Apk')) { " (the default build output of $ProjectPath)" }). Pass -Apk <apk>, or build first."
    }
    if ($Target -eq 'WebGL' -and -not (Test-Path -LiteralPath ([IO.Path]::Combine($BuildDir, 'index.html')) -PathType Leaf)) {
        throw "No index.html in $BuildDir$(if (-not $bound.ContainsKey('BuildDir')) { " (the default build output of $ProjectPath)" }). Pass -BuildDir <folder>, or build first."
    }
    if ($Target -eq 'Windows' -and -not (Test-Path -LiteralPath $Exe -PathType Leaf)) {
        throw "No exe at $Exe$(if (-not $bound.ContainsKey('Exe')) { " (the default build output of $ProjectPath)" }). Pass -Exe <file.exe>, or build first."
    }
} else {
    # The sample's EmuBuild methods overwrite company name, app id and scene list: only for the bundled sample.
    $isSample = $ProjectPath -ieq (Remove-TrailingSeparator (Resolve-Path -LiteralPath ([IO.Path]::Combine($RepoRoot, 'sample\EmuSmoke'))).ProviderPath)
    if (-not $Method -and -not $BuildProfile) {
        if (-not $isSample) {
            throw 'Pass -Method <Class.Method> or -BuildProfile <asset> for your project (see AGENTS.md: templates/EmuProjectBuild.cs), or build elsewhere and use -SkipBuild.'
        }
        $Method = @{ Android = 'EmuBuild.BuildApk'; WebGL = 'EmuBuild.BuildWebGL'; Windows = 'EmuBuild.BuildWindows' }[$Target]
    }
    # Fail before the emulator boots when the project's exact Unity version or its target module is missing.
    $u = Get-UnityEditorForProject $ProjectPath
    $hint = "Add it in Unity Hub > Installs > $($u.Version) > Add modules (scripts\doctor.ps1 -ProjectPath <p> -Target $Target lists what is missing)."
    if ($Target -eq 'Android') {
        $miss = @(Get-UnityAndroidMissing $u.Path)
        if ($miss) { throw "Unity $($u.Version) lacks Android Build Support parts: $($miss -join ', '). $hint" }
    } elseif ($Target -eq 'WebGL' -and -not (Test-Path -LiteralPath (Join-Path $u.Path 'Editor\Data\PlaybackEngines\WebGLSupport'))) {
        throw "Unity $($u.Version) lacks WebGL Build Support. $hint"
    } elseif ($Target -eq 'Windows') {
        $backend = Get-ProjectStandaloneBackend $ProjectPath
        $miss = @(Get-UnityWindowsMissing $u.Path $backend)
        if ($miss) { throw "Unity $($u.Version) lacks $($miss -join ', ') (the project's Windows scripting backend is $backend). $hint" }
    }
    $buildArgs = Get-PassThrough @('BuildProfile', 'ExtraArgs', 'TimeoutMinutes', 'EmuArm64', 'WebGLCompression')
    if ($Method) { $buildArgs['Method'] = $Method }
    if ($Release) { $buildArgs['Release'] = $true }
}

if ($Target -eq 'Android') {
    & "$PSScriptRoot\start-emulator.ps1" -Headless:$Headless
    if (-not $SkipBuild) {
        & "$PSScriptRoot\build-unity.ps1" -ProjectPath $ProjectPath -Target Android -Out $Apk @buildArgs
    }
    $smokeArgs = Get-PassThrough ($shared + @('Package', 'NotifDelay', 'NotifScheduledRegex', 'OpenedMarker', 'NoOpenedMarker',
        'NotifTimeoutSec', 'TimeTravelMinutes', 'AskPermission'))
    $smokeArgs['Apk'] = $Apk
    & "$PSScriptRoot\smoke-test.ps1" @smokeArgs
} elseif ($Target -eq 'WebGL') {
    if (-not $SkipBuild) {
        & "$PSScriptRoot\build-unity.ps1" -ProjectPath $ProjectPath -Target WebGL -Out $BuildDir @buildArgs
    }
    $smokeArgs = Get-PassThrough ($shared + @('ReadyMode', 'ReadyExpression', 'TapExpression', 'TapTimeoutSec',
        'TapRetrySec', 'AfterTapExpression', 'AfterTapTimeoutSec', 'SettleSec',
        'FailExpression', 'InfoExpression', 'Width', 'Height', 'Browser', 'NoIsolation', 'KeepProfile'))
    $smokeArgs['BuildDir'] = $BuildDir
    if ($Headless) { $smokeArgs['Headless'] = $true }
    & "$PSScriptRoot\smoke-webgl.ps1" @smokeArgs
} else {
    if (-not $SkipBuild) {
        & "$PSScriptRoot\build-unity.ps1" -ProjectPath $ProjectPath -Target Windows -Out $Exe @buildArgs
    }
    $smokeArgs = Get-PassThrough @('ReadyMarker', 'ReadyTimeoutSec', 'TapX', 'TapY', 'TapMarker', 'NoTapCheck', 'Width', 'Height',
        'SettleSec', 'Tap', 'CleanPrefs', 'AllowAudio', 'FailOnException', 'ExeArgs')
    $smokeArgs['Exe'] = $Exe
    & "$PSScriptRoot\smoke-windows.ps1" @smokeArgs
}
exit $LASTEXITCODE
