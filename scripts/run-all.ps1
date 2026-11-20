# One entry point for people and agents: build -> run -> self-test.
#   Android : boot emulator -> build APK -> smoke-test.ps1 (incl. local notification in the shade)
#   WebGL   : build WebGL folder -> smoke-webgl.ps1 (local server + Chrome/Edge over DevTools)
#
#   run-all.ps1                                    # sample project, Android
#   run-all.ps1 -Target WebGL                      # sample project, WebGL
#   run-all.ps1 -ProjectPath <p> -Method EmuProjectBuild.BuildApk -EmuArm64 -ReadyMarker "<log line>" -NoTapCheck -NotifDelay 0
#   run-all.ps1 -SkipBuild -Apk <apk> -ReadyMarker "<log line>" -NoTapCheck -NotifDelay 0
#   run-all.ps1 -Target WebGL -SkipBuild -BuildDir <dir> -ReadyMode Loaded -NoTapCheck
# -Apk / -BuildDir are the build output AND what gets tested. Default (Get-DefaultBuildOut, common.ps1): the sample's
#   own Builds\ folder, or artifacts\builds\<project>-<hash>\ in this repo for any other -ProjectPath.
# Build options go to build-unity.ps1: -Method or -BuildProfile (one is required for a project other than the sample),
#   -EmuArm64, -TimeoutMinutes, -Release, -WebGLCompression, -ExtraArgs (an array: only with powershell -Command).
# Test options are passed through to smoke-test.ps1 / smoke-webgl.ps1 when given. An option of the other target,
#   or a build option together with -SkipBuild, is an error (nothing is silently dropped).
param(
    [ValidateSet('Android', 'WebGL')] [string]$Target = 'Android',
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
    [switch]$KeepProfile
)
$ErrorActionPreference = 'Stop'
# Without [CmdletBinding()] unknown options land in $args; refuse them instead of silently dropping them.
# ([CmdletBinding()] is avoided because PS 5.1 leaves $PSScriptRoot empty in its param defaults under -File.)
if ($args.Count) { throw "Unknown option(s): $($args -join ' ')" }
# powershell -File reads a path ending in \ before its closing quote as a literal quote and swallows what follows.
foreach ($a in 'ProjectPath', 'Apk', 'BuildDir', 'BuildProfile') { if ("$(Get-Variable $a -ValueOnly)" -match '"') { throw ("-$a contains a quote: " + 'remove the trailing backslash from that path (powershell -File reads \" as a literal quote).') } }

# Inside a function $PSBoundParameters would be the function's own; keep the script's.
$bound = $PSBoundParameters
function Get-PassThrough([string[]]$Keys) {
    $h = @{}
    foreach ($k in $Keys) { if ($bound.ContainsKey($k)) { $h[$k] = $bound[$k] } }
    return $h
}
$shared = 'ReadyMarker', 'ReadyTimeoutSec', 'TapX', 'TapY', 'TapMarker', 'NoTap', 'NoTapCheck'
$androidOnly = 'Apk', 'EmuArm64', 'Package', 'NotifDelay', 'NotifScheduledRegex', 'OpenedMarker', 'NoOpenedMarker',
    'NotifTimeoutSec', 'TimeTravelMinutes', 'AskPermission'
$webglOnly = 'BuildDir', 'WebGLCompression', 'ReadyMode', 'ReadyExpression', 'TapExpression', 'TapTimeoutSec', 'TapRetrySec',
    'AfterTapExpression', 'AfterTapTimeoutSec', 'SettleSec', 'FailExpression', 'InfoExpression', 'Width', 'Height',
    'Browser', 'NoIsolation', 'KeepProfile'
$buildOnly = 'Method', 'BuildProfile', 'ExtraArgs', 'TimeoutMinutes', 'EmuArm64', 'Release', 'WebGLCompression'

# Refuse option mixes before anything boots or builds (e.g. a WebGL run that forgot -Target WebGL would
# otherwise smoke the sample APK and could print SMOKE PASS).
$other = if ($Target -eq 'Android') { 'WebGL' } else { 'Android' }
$wrong = @((@{ Android = $webglOnly; WebGL = $androidOnly })[$Target] | Where-Object { $bound.ContainsKey($_) })
if ($wrong) { throw "-$($wrong -join ', -'): only for -Target $other, but this run is -Target $Target$(if (-not $bound.ContainsKey('Target')) { ' (the default)' }). Add -Target $other or drop them." }
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
$needProject = (-not $SkipBuild) -or ($Target -eq 'Android' -and -not $Apk) -or ($Target -eq 'WebGL' -and -not $BuildDir)
if ($needProject) { $ProjectPath = Remove-TrailingSeparator (Resolve-Path -LiteralPath $ProjectPath).ProviderPath }
if ($Target -eq 'Android' -and -not $Apk) { $Apk = Get-DefaultBuildOut $ProjectPath 'Android' }
if ($Target -eq 'WebGL' -and -not $BuildDir) { $BuildDir = Get-DefaultBuildOut $ProjectPath 'WebGL' }

if ($SkipBuild) {
    # Fail before the emulator boots when there is nothing to test.
    if ($Target -eq 'Android' -and -not (Test-Path -LiteralPath $Apk -PathType Leaf)) {
        throw "No APK at $Apk$(if (-not $bound.ContainsKey('Apk')) { " (the default build output of $ProjectPath)" }). Pass -Apk <apk>, or build first."
    }
    if ($Target -eq 'WebGL' -and -not (Test-Path -LiteralPath ([IO.Path]::Combine($BuildDir, 'index.html')) -PathType Leaf)) {
        throw "No index.html in $BuildDir$(if (-not $bound.ContainsKey('BuildDir')) { " (the default build output of $ProjectPath)" }). Pass -BuildDir <folder>, or build first."
    }
} else {
    # The sample's EmuBuild methods overwrite company name, app id and scene list: only for the bundled sample.
    $isSample = $ProjectPath -ieq (Remove-TrailingSeparator (Resolve-Path -LiteralPath ([IO.Path]::Combine($RepoRoot, 'sample\EmuSmoke'))).ProviderPath)
    if (-not $Method -and -not $BuildProfile) {
        if (-not $isSample) {
            throw 'Pass -Method <Class.Method> or -BuildProfile <asset> for your project (see AGENTS.md: templates/EmuProjectBuild.cs), or build elsewhere and use -SkipBuild.'
        }
        $Method = if ($Target -eq 'Android') { 'EmuBuild.BuildApk' } else { 'EmuBuild.BuildWebGL' }
    }
    # Fail before the emulator boots when the project's exact Unity version or its target module is missing.
    $u = Get-UnityEditorForProject $ProjectPath
    $hint = "Add it in Unity Hub > Installs > $($u.Version) > Add modules (scripts\doctor.ps1 -ProjectPath <p> -Target $Target lists what is missing)."
    if ($Target -eq 'Android') {
        $miss = @(Get-UnityAndroidMissing $u.Path)
        if ($miss) { throw "Unity $($u.Version) lacks Android Build Support parts: $($miss -join ', '). $hint" }
    } elseif (-not (Test-Path -LiteralPath (Join-Path $u.Path 'Editor\Data\PlaybackEngines\WebGLSupport'))) {
        throw "Unity $($u.Version) lacks WebGL Build Support. $hint"
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
} else {
    if (-not $SkipBuild) {
        & "$PSScriptRoot\build-unity.ps1" -ProjectPath $ProjectPath -Target WebGL -Out $BuildDir @buildArgs
    }
    $smokeArgs = Get-PassThrough ($shared + @('ReadyMode', 'ReadyExpression', 'TapExpression', 'TapTimeoutSec',
        'TapRetrySec', 'AfterTapExpression', 'AfterTapTimeoutSec', 'SettleSec',
        'FailExpression', 'InfoExpression', 'Width', 'Height', 'Browser', 'NoIsolation', 'KeepProfile'))
    $smokeArgs['BuildDir'] = $BuildDir
    if ($Headless) { $smokeArgs['Headless'] = $true }
    & "$PSScriptRoot\smoke-webgl.ps1" @smokeArgs
}
exit $LASTEXITCODE
