# Move the emulator wall clock so long-delay local notifications (hours/days) fire now.
# Unity Mobile Notifications schedules RTC_WAKEUP alarms. Without exact scheduling they are inexact:
# Android (API 31+) may deliver up to 1 hour after FireTime, so jump past FireTime + 1h (+ margin).
#
#   time-travel.ps1 -Minutes 125     # jump forward 2h05m
#   time-travel.ps1 -Reset           # back to host time, automatic time on again (safe to run again)
# Always run -Reset when done, also after a failed check: the AVD otherwise keeps the moved clock.
# Targets $env:EMU_SERIAL when it is the unity-test AVD, else finds that emulator itself (never another one).
param(
    [int]$Minutes,
    [switch]$Reset
)
. "$PSScriptRoot\common.ps1"

if ($env:EMU_SERIAL) {
    Start-AdbServer
    if ((Get-EmulatorAvdName $env:EMU_SERIAL) -ne $DefaultAvd) { $env:EMU_SERIAL = $null }
}
if (-not $env:EMU_SERIAL) { $env:EMU_SERIAL = Get-EmulatorSerial -WaitSec 30 }
if (-not $env:EMU_SERIAL) { throw 'No running emulator.' }
# Moving the clock forward needs the device to be ours; -Reset only restores it (watchdogs and releases call it).
if (-not $Reset) { [void](Assert-EmuLeaseUsable) }

function Set-DeviceTimeMs([int64]$Ms) {
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $out = (Invoke-Adb shell cmd alarm set-time $Ms 2>&1) -join ' '
    if ($out -match 'Exception|denied|Unknown') {
        # Fallback: root shell + toybox date (google_apis images allow adb root).
        # adbd restarts as root, so wait until the device answers again (a fixed 2 s was not always enough).
        Invoke-Adb root | Out-Null
        $deadline = (Get-Date).AddSeconds(20)
        do {
            Start-Sleep -Seconds 1
            $alive = ((Invoke-Adb shell echo ok) -join '').Trim() -eq 'ok'
        } while (-not $alive -and (Get-Date) -lt $deadline)
        if (-not $alive) { throw "Device $env:EMU_SERIAL did not come back after adb root." }
        # Keep the target moving with real time while we waited.
        $t = [DateTimeOffset]::FromUnixTimeMilliseconds($Ms + $sw.ElapsedMilliseconds).UtcDateTime.ToString('MMddHHmmyyyy.ss')
        Invoke-Adb shell date -u $t | Out-Null
    }
}

$before = Get-DeviceEpochMs
if ($Reset) {
    $target = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    Set-DeviceTimeMs $target
    Invoke-Adb shell settings put global auto_time 1 | Out-Null
} else {
    if ($Minutes -le 0) { throw 'Pass -Minutes N (N > 0) or -Reset.' }
    Invoke-Adb shell settings put global auto_time 0 | Out-Null
    $target = $before + [int64]$Minutes * 60 * 1000
    Set-DeviceTimeMs $target
}
Start-Sleep -Seconds 1
$after = Get-DeviceEpochMs
$fmt = { param($ms) [DateTimeOffset]::FromUnixTimeMilliseconds($ms).ToLocalTime().ToString('yyyy-MM-dd HH:mm:ss') }
Write-Host ("TIME_TRAVEL before={0} after={1} delta_min={2:N1}" -f (& $fmt $before), (& $fmt $after), (($after - $before) / 60000))
