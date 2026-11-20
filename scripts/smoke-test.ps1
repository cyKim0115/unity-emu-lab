# Install an APK on the running emulator and self-test it from outside the app:
# launch -> ready marker -> tap -> background -> local notification in the shade -> tap back in.
# Results: artifacts\<stamp>-smoke-<pid>\ (logcat.txt, unity.txt, PNG screenshots, summary.json). Exit 0 PASS / 1 FAIL.
#
#   smoke-test.ps1 -Apk sample\EmuSmoke\Builds\Android\app.apk
#   smoke-test.ps1 -Apk game.apk -ReadyMarker "SomeLogLine" -NoTapCheck -NotifDelay 0
#   smoke-test.ps1 -Apk game.apk -ReadyMarker "<log>" -TapMarker "<tap log>" -NotifScheduledRegex "Scheduled notification: (.+)" -NoOpenedMarker
# -Package defaults to the APK's own package (read with aapt2); a mismatch is an error.
# Markers and -NotifScheduledRegex are looked for in the logcat captured since launch. The defaults are the sample's
# lines: SMOKE_APP_READY, SMOKE_TAP count=1, SMOKE_NOTIF_SCHEDULED id=<n> title=<title without spaces>,
# SMOKE_OPENED_FROM_NOTIFICATION.
# If the app process ends by itself while the script waits (no crash or ANR logged), the run fails with
# app_exited=true: see logcat.txt (emulator/root/integrity detection, start-up checks).
param(
    [Parameter(Mandatory)] [string]$Apk,
    [string]$Package,
    [string]$ReadyMarker = 'SMOKE_APP_READY',
    [int]$ReadyTimeoutSec = 120,
    [double]$TapX = 0.5,             # fraction of the current (rotated) screen
    [double]$TapY = 0.5,
    [string]$TapMarker = 'SMOKE_TAP count=1',   # plain text the app logs when the tap lands
    [switch]$NoTap,                  # skip the tap step
    [switch]$NoTapCheck,             # tap, but do not wait for -TapMarker
    [int]$NotifDelay = 20,           # passed to the app as "--es notif_delay"; 0 skips the notification check
    # Regex over the logcat text; capture group 1 = the notification title (a plain substring for check-notification).
    # '.' stops at the end of the line, so "Scheduled notification: (.+)" takes the rest of that line (trimmed).
    [string]$NotifScheduledRegex = 'SMOKE_NOTIF_SCHEDULED id=\d+ title=(\S+)',
    [string]$OpenedMarker = 'SMOKE_OPENED_FROM_NOTIFICATION',   # plain text the app logs when opened from the notification
    [switch]$NoOpenedMarker,         # the app logs nothing then: "opened" = its activity is resumed after the tap
    [int]$NotifTimeoutSec = 240,
    [int]$TimeTravelMinutes = 0,     # >0: jump the device clock forward after scheduling (long-delay notifications)
    [switch]$AskPermission           # revoke POST_NOTIFICATIONS so the system permission dialog shows again
)
. "$PSScriptRoot\common.ps1"

# Check the options before touching the device.
try { $schedRe = [regex]$NotifScheduledRegex } catch { throw "-NotifScheduledRegex is not a valid regex: $($_.Exception.Message)" }
if ($schedRe.GetGroupNumbers() -notcontains 1) {
    throw '-NotifScheduledRegex needs capture group 1 = the notification title, e.g. "Scheduled notification: (.+)".'
}
if ($TimeTravelMinutes -gt 0 -and $NotifDelay -le 0) {
    throw '-TimeTravelMinutes needs the automatic notification check (-NotifDelay > 0 and a log line that matches -NotifScheduledRegex). With -NotifDelay 0: schedule in the game, time-travel.ps1 -Minutes N, check-notification.ps1, then always time-travel.ps1 -Reset.'
}

$env:EMU_SERIAL = Get-EmulatorSerial -WaitSec 60
if (-not $env:EMU_SERIAL) { throw 'No running emulator. Run scripts\start-emulator.ps1 first.' }
# Another session's lease stops the run here, before anything is installed (start-emulator.ps1 takes the lease).
[void](Assert-EmuLeaseUsable)
Assert-PathArg 'Apk' $Apk
$Apk = (Resolve-Path -LiteralPath $Apk).ProviderPath
$apkPackage = Get-ApkPackage $Apk
if (-not $Package) { $Package = $apkPackage }
if (-not $Package) { throw "Could not read the package name of $Apk; pass -Package." }
if ($apkPackage -and $apkPackage -ne $Package) { throw "-Package $Package does not match the APK ($apkPackage)." }

$run = New-RunDir 'smoke'
$logPath = Join-Path $run 'logcat.txt'
$checks = [ordered]@{ package = $Package }
# Only crashes of this package count (other system processes may log fatal lines too).
$p = [regex]::Escape($Package)
$crashRegex = "FATAL EXCEPTION[^\n]*\n[^\n]*Process: $p|Fatal signal \d+[^\n]*\($p\)|>>> $p <<<|ANR in $p"

function Read-Log {
    if (-not (Test-Path -LiteralPath $logPath)) { return '' }
    $fs = [IO.File]::Open($logPath, 'Open', 'Read', 'ReadWrite')
    try { return (New-Object IO.StreamReader($fs)).ReadToEnd() } finally { $fs.Dispose() }
}
function Test-AppExited {
    # True only when "pidof" prints nothing twice in a row. adb errors print text, so they count as "running".
    for ($i = 0; $i -lt 2; $i++) {
        if ($i) { Start-Sleep -Seconds 2 }
        if (((Invoke-Adb shell pidof $Package) -join ' ').Trim()) { return $false }
    }
    # pidof matches the exact process name only. An app with android:process (e.g. "com.x:game") still runs under
    # another name, so also look for any "<package>" / "<package>:..." process and a resumed activity of the package.
    $names = @(Invoke-Adb shell ps -A -o NAME | ForEach-Object { "$_".Trim() })
    if ($names | Where-Object { $_ -eq $Package -or $_.StartsWith("${Package}:") }) { return $false }
    $top = ((Invoke-Adb shell dumpsys activity activities) | Where-Object { "$_" -match 'topResumedActivity|mResumedActivity' }) -join ' '
    if ($top.Contains("$Package/")) { return $false }
    return $true
}
function Stop-OnAppExit([string]$During) {
    # The process is gone. A crash report may still be on its way into logcat.txt.
    Start-Sleep -Seconds 1
    if ((Read-Log) -match $crashRegex) { $checks.crash = $true; throw "The app crashed during $During (see logcat.txt and unity.txt in $run)." }
    $checks.app_exited = $true
    $lines = @((Read-Log) -split "`n" | Where-Object { $_.Contains($Package) -and $_ -match 'ActivityManager|ActivityTaskManager|Zygote|libprocessgroup' } |
        Select-Object -Last 5 | ForEach-Object { $_.Trim() })
    if ($lines) { $checks.app_exit_log = $lines }
    throw ("The app process ($Package) ended by itself during $During, with no crash or ANR in the log. " +
        "See logcat.txt in $run (the app's last lines, and ActivityManager/Zygote lines about $Package). " +
        'Likely causes: an anti-cheat, integrity or tamper check that quits on an emulator, a rootable (adb root) image ' +
        'or a debug-signed build; or a start-up error or check (login, patch server, network) that calls Application.Quit. ' +
        'Such a build cannot be tested here as is: ask the person for a test build with that check off; do not patch or bypass it.')
}
function Wait-Log([string]$Regex, [int]$TimeoutSec, [switch]$WatchDialogs, [switch]$WatchApp) {
    # -WatchApp: also stop when the app process is gone (returns exited = $true).
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    $nextDialogCheck = (Get-Date).AddSeconds(5)
    $nextAppCheck = (Get-Date).AddSeconds(3)
    while ((Get-Date) -lt $deadline) {
        $text = Read-Log
        if ($text -match $crashRegex) { return @{ ok = $false; crash = $true } }
        $m = [regex]::Match($text, $Regex)
        if ($m.Success) { return @{ ok = $true; match = $m } }
        if ($WatchApp -and (Get-Date) -gt $nextAppCheck) {
            if (Test-AppExited) { return @{ ok = $false; crash = $false; exited = $true } }
            $nextAppCheck = (Get-Date).AddSeconds(3)
        }
        if ($WatchDialogs -and (Get-Date) -gt $nextDialogCheck) {
            if (Resolve-SystemDialog $Package (Join-Path $run 'system-dialogs.txt')) { $script:dialogsTapped++ }
            $nextDialogCheck = (Get-Date).AddSeconds(5)
        }
        Start-Sleep -Milliseconds 1000
    }
    return @{ ok = $false; crash = $false }
}
$script:dialogsTapped = 0
$script:timeTravelled = $false
$script:clockReset = $false

$logcat = $null; $watchdog = $null; $clockWatchdog = $null
try {
    # If this script is killed before its finally block, the watchdog stops the logcat capture.
    $watchdog = Start-Watchdog $run

    # Unity Mono builds are ARMv7-only; the API 35 x86_64 AVD runs only x86_64 / arm64-v8a code.
    $apkAbis = @(Get-ApkAbis $Apk)
    $devAbis = @(((Invoke-Adb shell getprop ro.product.cpu.abilist) -join '').Trim() -split ',' | Where-Object { $_ })
    $checks.apk_abis = $apkAbis -join ','
    $checks.device_abis = $devAbis -join ','
    # An empty device list means adb could not read it: then let the install itself decide.
    if ($apkAbis.Count -gt 0 -and $devAbis.Count -gt 0 -and -not ($apkAbis | Where-Object { $devAbis -contains $_ })) {
        $checks.install = $false
        throw "APK native ABIs ($($checks.apk_abis)) cannot run on this emulator ($($checks.device_abis)). Build an IL2CPP + ARM64 test APK (templates/EmuProjectBuild.cs with -emuArm64, see AGENTS.md); do not recreate the AVD."
    }

    # Install
    $install = (Invoke-Adb install -r $Apk) -join ' '
    $checks.install = $install -match 'Success'
    if (-not $checks.install) { throw "Install failed: $install" }
    # release-emulator.ps1 -Uninstall removes what was installed under the lease.
    Add-EmuLeaseInstalled $Package
    $perm = 'android.permission.POST_NOTIFICATIONS'
    if ($AskPermission) {
        # install -r keeps earlier grants; reset them so the runtime dialog appears again.
        Invoke-Adb shell pm revoke $Package $perm | Out-Null
        Invoke-Adb shell pm clear-permission-flags $Package $perm user-set user-fixed | Out-Null
    } else {
        Invoke-Adb shell pm grant $Package $perm | Out-Null
    }

    # Launch with logcat capture
    Invoke-Adb logcat -c | Out-Null
    $logcat = Start-Detached $Adb @('-s', $env:EMU_SERIAL, 'logcat', '-v', 'time') $logPath $null
    $activity = Get-LauncherActivity $Package
    Invoke-Adb shell am force-stop $Package | Out-Null
    $sinceMs = Get-DeviceEpochMs
    $start = (Invoke-Adb shell am start -W -n $activity --es notif_delay $NotifDelay) -join ' '
    if ($start -match 'TotalTime: (\d+)') { $checks.launch_ms = [int]$Matches[1] }
    $checks.launch = $start -match 'Status: ok'
    # Watch the process only after a launch that adb reported as started (else "gone" would just mean "never ran").
    $watchApp = [bool]$checks.launch
    if ($watchApp) { $checks.app_exited = $false }

    $ready = Wait-Log ([regex]::Escape($ReadyMarker)) $ReadyTimeoutSec -WatchDialogs -WatchApp:$watchApp
    $checks.ready = $ready.ok
    $checks.system_dialogs_tapped = $script:dialogsTapped
    $checks.crash = [bool]$ready.crash
    Save-Screenshot (Join-Path $run '01-ready.png')
    if ($ready.exited) { Stop-OnAppExit "the wait for the ready marker '$ReadyMarker'" }
    if (-not $ready.ok) { throw "Ready marker '$ReadyMarker' not seen (crash=$($ready.crash))." }

    # Input: tap a point given as a fraction of the current logical screen (after rotation)
    if (-not $NoTap) {
        $disp = (Invoke-Adb shell dumpsys window displays) -join ' '
        $w = 0; $h = 0
        if ($disp -match '\bcur=(\d+)x(\d+)') { $w = [int]$Matches[1]; $h = [int]$Matches[2] }
        if ($w -gt 0 -and $h -gt 0) {
            $x = [int]($w * $TapX); $y = [int]($h * $TapY)
            $checks.tap_point = "$x,$y of ${w}x$h"
            # The first frames after start-up can drop input, so settle briefly and retry.
            Start-Sleep -Seconds 2
            for ($attempt = 1; $attempt -le 3; $attempt++) {
                Invoke-Adb shell input tap $x $y | Out-Null
                if ($NoTapCheck) { break }
                $tapWait = Wait-Log ([regex]::Escape($TapMarker)) 5 -WatchApp:$watchApp
                $checks.tap = $tapWait.ok
                $checks.tap_attempts = $attempt
                if ($tapWait.exited) { Stop-OnAppExit "the wait for the tap marker '$TapMarker'" }
                if ($checks.tap) { break }
            }
            Save-Screenshot (Join-Path $run '02-after-tap.png')
        }
    }
    # A tap (or a start-up check) can also end the app a few seconds in; -NoTapCheck alone would not notice.
    if ($watchApp -and (Test-AppExited)) { Stop-OnAppExit 'the tap step' }

    # Local notification, checked from outside the app
    if ($NotifDelay -gt 0) {
        $sched = Wait-Log $NotifScheduledRegex 30 -WatchApp:$watchApp
        if ($sched.exited) { Stop-OnAppExit 'the wait for the scheduled-notification log (-NotifScheduledRegex)' }
        $checks.notif_scheduled = $sched.ok
        if ($sched.ok) {
            $title = $sched.match.Groups[1].Value.Trim()
            if (-not $title) { throw "-NotifScheduledRegex matched '$($sched.match.Value.Trim())' but its group 1 (the title) is empty." }
            Invoke-Adb shell input keyevent KEYCODE_HOME | Out-Null
            Start-Sleep -Seconds 1
            Save-Screenshot (Join-Path $run '03-home.png')
            if ($TimeTravelMinutes -gt 0) {
                # Mark the clock for reset first: time-travel.ps1 can fail after it has already moved the clock.
                # The clock watchdog resets it if this script is killed before its finally block. Its log path uses '/'
                # so the run-dir watchdog (which stops processes whose command line names '<run>\') leaves it alone.
                $script:timeTravelled = $true
                $clockWatchdog = Start-Detached 'powershell.exe' @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
                    (Join-Path $PSScriptRoot 'watch-parent.ps1'), '-ParentPid', "$PID", '-ResetClock') ($run + '/clock-watchdog.log') $null
                & "$PSScriptRoot\time-travel.ps1" -Minutes $TimeTravelMinutes
                $checks.time_travel_min = $TimeTravelMinutes
            }
            $notifArgs = @{ Package = $Package; Title = $title; TimeoutSec = $NotifTimeoutSec; SinceMs = $sinceMs; Tap = $true; RunDir = $run }
            if ($OpenedMarker -and -not $NoOpenedMarker) { $notifArgs['OpenedMarker'] = $OpenedMarker; $notifArgs['LogFile'] = $logPath }
            $checks.notif_opened_check = if ($notifArgs.ContainsKey('OpenedMarker')) { 'marker' } else { 'resumed activity' }
            & "$PSScriptRoot\check-notification.ps1" @notifArgs
            $n = Get-Content -LiteralPath (Join-Path $run 'notification-check.json') -Raw -Encoding UTF8 | ConvertFrom-Json
            $checks.notif_title = $title
            $checks.notif_posted = $n.posted
            $checks.notif_posted_after_sec = $n.posted_after_sec
            $checks.notif_in_shade = $n.in_shade
            $checks.notif_opened_app = $n.opened_app
        }
    }
    $checks.crash = (Read-Log) -match $crashRegex
}
catch {
    $checks.error = $_.Exception.Message
}
finally {
    if ($script:timeTravelled) {
        try { & "$PSScriptRoot\time-travel.ps1" -Reset; $script:clockReset = $true }
        catch { $checks.clock_reset_error = $_.Exception.Message; Write-Host "CLOCK_RESET_FAILED $($_.Exception.Message) (the clock watchdog retries after this script exits)" }
    }
    # Stop the clock watchdog only once the clock is back; otherwise it runs time-travel.ps1 -Reset when we exit.
    if ($clockWatchdog -and $script:clockReset) { Stop-ProcessTree $clockWatchdog.Id }
    if ($logcat) { Stop-ProcessTree $logcat.Id }
    $unityLines = (Read-Log) -split "`n" | Where-Object { $_ -match '/(Unity|AndroidRuntime|DEBUG|libc)\s*\(' }
    Set-Content -LiteralPath (Join-Path $run 'unity.txt') -Value $unityLines -Encoding UTF8
    if ($watchdog) { Stop-ProcessTree $watchdog.Id }
}

$failed = @('install', 'launch', 'ready', 'tap', 'notif_scheduled', 'notif_posted', 'notif_in_shade', 'notif_opened_app') |
    Where-Object { $checks.Contains($_) -and -not $checks[$_] }
$pass = (-not $failed) -and (-not $checks.crash) -and (-not $checks.error) -and (-not $checks.app_exited)
$checks.pass = $pass
$checks.run_dir = $run
$checks | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $run 'summary.json') -Encoding UTF8
$checks.GetEnumerator() | ForEach-Object { Write-Host ("  {0,-24} {1}" -f $_.Key, $_.Value) }
Write-Host "SMOKE $(if ($pass) { 'PASS' } else { 'FAIL' }) dir=$run"
exit $(if ($pass) { 0 } else { 1 })
