# Verify from OUTSIDE the app that a notification really reached the Android system UI.
#   1) NotificationManager has it      (dumpsys notification --noredact), posted at/after -SinceMs
#   2) SystemUI renders it in the shade (cmd statusbar expand-notifications + uiautomator dump)
#   3) optional: tapping it opens the app (-Tap; checks -OpenedMarker in the log, else the resumed activity)
#
#   check-notification.ps1 -Package com.example.emusmoke -Title EMU-SMOKE -Tap
#   check-notification.ps1 -Package <id> -Title "<title part>" -Tap -OpenedMarker "<log line>"
# -Title is a plain substring (no wildcards); non-ASCII titles work.
# Only notifications posted at/after -SinceMs (device epoch ms, default: when this script starts) count,
# so an older notification with the same title cannot pass the check.
# -OpenedMarker is looked for in what -LogFile gains after the tap, so -LogFile must be a capture that is still being
# written (smoke-test.ps1 passes its own). Without -LogFile this script captures logcat itself (<run dir>\notification-logcat.txt).
param(
    [Parameter(Mandatory)] [string]$Package,
    [Parameter(Mandatory)] [string]$Title,
    [int]$TimeoutSec = 240,
    [int64]$SinceMs = 0,
    [switch]$Tap,
    [string]$OpenedMarker,
    [string]$LogFile,
    [string]$RunDir
)
. "$PSScriptRoot\common.ps1"

if (-not $env:EMU_SERIAL) { $env:EMU_SERIAL = Get-EmulatorSerial -WaitSec 30 }
if (-not $env:EMU_SERIAL) { throw 'No running emulator.' }
[void](Assert-EmuLeaseUsable)
# Absolute paths: the logcat redirect (cmd) and [IO.File] resolve relative paths against the process directory, not $PWD.
foreach ($a in 'RunDir', 'LogFile') {
    $v = Get-Variable $a -ValueOnly
    if ($v) { Set-Variable $a $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($v) }
}
if ($RunDir) { [void][IO.Directory]::CreateDirectory($RunDir) } else { $RunDir = New-RunDir 'notification' }
if ($SinceMs -le 0) { $SinceMs = Get-DeviceEpochMs }

function Read-Shared([string]$Path) {
    if (-not $Path -or -not (Test-Path -LiteralPath $Path)) { return '' }
    $fs = [IO.File]::Open($Path, 'Open', 'Read', 'ReadWrite')
    try { return (New-Object IO.StreamReader($fs)).ReadToEnd() } finally { $fs.Dispose() }
}
function Test-PackageResumed {
    $top = (Invoke-Adb shell dumpsys activity activities | Select-String 'topResumedActivity') -join ' '
    return $top -match [regex]::Escape("$Package/")
}

$result = [ordered]@{ package = $Package; title = $Title; since_ms = $SinceMs; posted = $false;
                      posted_after_sec = $null; posted_at_ms = $null; in_shade = $false;
                      backgrounded_before_tap = $false; tapped = $false; opened_app = $false }
if ($Tap) { $result.opened_check = if ($OpenedMarker) { 'marker' } else { 'resumed activity' } }
$sw = [Diagnostics.Stopwatch]::StartNew()

$logcat = $null; $watchdog = $null
try {
    if ($Tap -and $OpenedMarker -and -not $LogFile) {
        # Standalone: capture logcat now so the marker logged after the tap can be seen. "-T 1" starts at the newest
        # line, so an old marker still in the device buffer does not count, and the buffer is not cleared.
        # The watchdog stops the capture if this script is killed before its finally block.
        $LogFile = Join-Path $RunDir 'notification-logcat.txt'
        $result.log_file = $LogFile
        $logcat = Start-Detached $Adb @('-s', $env:EMU_SERIAL, 'logcat', '-v', 'time', '-T', '1') $LogFile $null
        # Guard only this logcat (not every process naming -RunDir, which the caller may have chosen broadly).
        $watchdog = Start-Detached 'powershell.exe' @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
            (Join-Path $PSScriptRoot 'watch-parent.ps1'), '-ParentPid', "$PID", '-ChildPid', "$($logcat.Id)") (Join-Path $RunDir 'notification-watchdog.log') $null
    }

    # 1) NotificationManager record, newer than the baseline
    $dumpPath = Join-Path $RunDir 'notification_dump.txt'
    $recordPattern = "NotificationRecord\(.*?pkg=$([regex]::Escape($Package))[\s\S]*?(?=NotificationRecord\(|\z)"
    while ($sw.Elapsed.TotalSeconds -lt $TimeoutSec) {
        $dump = (Invoke-Adb shell dumpsys notification --noredact) -join "`n"
        foreach ($rec in [regex]::Matches($dump, $recordPattern)) {
            if (-not $rec.Value.Contains($Title)) { continue }
            $t = [regex]::Match($rec.Value, 'mUpdateTimeMs=(\d+)')
            if (-not $t.Success) { $t = [regex]::Match($rec.Value, 'mCreationTimeMs=(\d+)') }
            if ($t.Success -and [int64]$t.Groups[1].Value -lt $SinceMs) { continue }
            [IO.File]::WriteAllText($dumpPath, $rec.Value)
            $result.posted = $true
            $result.posted_after_sec = [math]::Round($sw.Elapsed.TotalSeconds)
            if ($t.Success) { $result.posted_at_ms = [int64]$t.Groups[1].Value }
            break
        }
        if ($result.posted) { break }
        Start-Sleep -Seconds 3
    }
    Write-Host "NOTIF_POSTED $($result.posted) after=$($result.posted_after_sec)s"

    if ($result.posted) {
        # Without a log marker, "app came to the front" only means something if it was not there already.
        if ($Tap -and (Test-PackageResumed)) {
            Invoke-Adb shell input keyevent KEYCODE_HOME | Out-Null
            Start-Sleep -Seconds 1
            $result.backgrounded_before_tap = $true
        }

        # 2) Rendered in the notification shade
        Invoke-Adb shell cmd statusbar expand-notifications | Out-Null
        Start-Sleep -Seconds 2
        $node = $null
        $xmlText = Get-UiDump
        Save-Screenshot (Join-Path $RunDir '04-shade.png')
        if ($xmlText) {
            [IO.File]::WriteAllText((Join-Path $RunDir 'shade.xml'), $xmlText, (New-Object Text.UTF8Encoding $false))
            [xml]$ui = $xmlText
            $node = $ui.SelectNodes('//node') | Where-Object { $_.text -and $_.text.Contains($Title) } | Select-Object -First 1
        }
        $result.in_shade = [bool]$node
        Write-Host "NOTIF_IN_SHADE $($result.in_shade)"

        # 3) Tap through to the app
        if ($Tap -and $node -and $node.bounds -match '\[(\d+),(\d+)\]\[(\d+),(\d+)\]') {
            $x = ([int]$Matches[1] + [int]$Matches[3]) / 2
            $y = ([int]$Matches[2] + [int]$Matches[4]) / 2
            $before = (Read-Shared $LogFile).Length
            Invoke-Adb shell input tap $x $y | Out-Null
            $result.tapped = $true
            $deadline = (Get-Date).AddSeconds(30)
            while ((Get-Date) -lt $deadline) {
                Start-Sleep -Seconds 2
                if ($OpenedMarker -and $LogFile) {
                    $log = Read-Shared $LogFile
                    if ($log.Length -gt $before -and $log.Substring($before).Contains($OpenedMarker)) {
                        $result.opened_app = $true; break
                    }
                } elseif (Test-PackageResumed) {
                    $result.opened_app = $true; break
                }
            }
            Start-Sleep -Seconds 1
            Save-Screenshot (Join-Path $RunDir '05-opened-from-notification.png')
            Write-Host "NOTIF_OPENED_APP $($result.opened_app)"
        } else {
            Invoke-Adb shell cmd statusbar collapse | Out-Null
        }
    }
}
finally {
    if ($logcat) { Stop-ProcessTree $logcat.Id }
    if ($watchdog) { Stop-ProcessTree $watchdog.Id }
}

$result | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $RunDir 'notification-check.json') -Encoding UTF8
$ok = $result.posted -and $result.in_shade -and ((-not $Tap) -or $result.opened_app)
Write-Host "NOTIFICATION_CHECK $(if ($ok) { 'PASS' } else { 'FAIL' }) dir=$RunDir"
if (-not $ok) { exit 1 }
