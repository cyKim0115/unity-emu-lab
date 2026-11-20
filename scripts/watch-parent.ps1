# Watchdog for processes a script starts (static server, browser, logcat, a hidden batchmode Unity build).
# Windows does not stop children when their parent dies, so if the caller is killed before its finally block
# runs (tool timeout, closed console, Stop-Process), they would keep running. This waits for -ParentPid to exit,
# then does what it was given:
#   -ChildPid   : if that process is still running, stop it with its children. Its handle is opened at start,
#                 so a reused PID cannot pass for it (build-unity.ps1 passes the Unity it started).
#   -Match      : stop every process whose command line contains the run dir, with its children.
#   -ResetClock : run time-travel.ps1 -Reset so the emulator clock goes back to host time ($env:EMU_SERIAL is
#                 inherited from the caller).
# Start it with Start-Detached (Start-Watchdog in common.ps1 does); the caller stops it at the end of its own cleanup.
#
#   watch-parent.ps1 -ParentPid 1234 -Match C:\...\artifacts\20261104-161916-webgl-1234
#   watch-parent.ps1 -ParentPid 1234 -ChildPid 5678
#   watch-parent.ps1 -ParentPid 1234 -Match C:\...\artifacts\20261104-161916-smoke-1234 -ResetClock
param(
    [Parameter(Mandatory)] [int]$ParentPid,
    [string]$Match,
    [int]$ChildPid,
    [switch]$ResetClock
)
$ErrorActionPreference = 'Continue'

function Stop-Tree([int]$Id, $Created) {
    # Follow only children created after their parent. A process whose parent died keeps that ParentProcessId,
    # and Windows can hand the PID to one of our processes later; a real child cannot predate its parent.
    # Without the parent's creation time (it is gone) the children are left alone rather than guessed.
    if (-not $Created) {
        $Created = (Get-CimInstance Win32_Process -Filter "ProcessId=$Id" -ErrorAction SilentlyContinue).CreationDate
    }
    if ($Created) {
        # Leave an adb server alone if this tree happened to fork it; other tools share it.
        Get-CimInstance Win32_Process -Filter "ParentProcessId=$Id" -ErrorAction SilentlyContinue |
            Where-Object { $_.CommandLine -notmatch 'fork-server' -and $_.CreationDate -and $_.CreationDate -ge $Created } |
            ForEach-Object { Stop-Tree $_.ProcessId $_.CreationDate }
    }
    Stop-Process -Id $Id -Force -ErrorAction SilentlyContinue
}

$child = $null
$childCreated = $null
if ($ChildPid) {
    $child = Get-Process -Id $ChildPid -ErrorAction SilentlyContinue
    if ($child) {
        try { [void]$child.Handle } catch { }   # keep a handle open so the PID cannot be reused while we wait
        $childCreated = (Get-CimInstance Win32_Process -Filter "ProcessId=$ChildPid" -ErrorAction SilentlyContinue).CreationDate
    } else {
        Write-Host "child $ChildPid is not running"
    }
}

$parent = Get-Process -Id $ParentPid -ErrorAction SilentlyContinue
if ($parent) {
    [void]$parent.Handle   # keep a handle open so a reused PID cannot pass for the parent
    $parent.WaitForExit()
}
Write-Host "$(Get-Date -Format 'HH:mm:ss') parent $ParentPid exited"

if ($child) {
    $running = $false
    try { $running = -not $child.HasExited } catch {
        # No handle: trust the PID only if it is still the same process (same creation time).
        $now = Get-CimInstance Win32_Process -Filter "ProcessId=$ChildPid" -ErrorAction SilentlyContinue
        $running = [bool]($now -and $childCreated -and $now.CreationDate -eq $childCreated)
    }
    if ($running) {
        Write-Host "stopping child $ChildPid $($child.ProcessName) with its children"
        Stop-Tree $ChildPid $childCreated
    } else {
        Write-Host "child $ChildPid already exited"
    }
}

if ($Match) {
    $needle = $Match.TrimEnd('\') + '\'
    Write-Host "cleaning up '$needle'"
    # Skip this watchdog and the cmd.exe that launched it; their command lines name the run dir too.
    $self = Get-CimInstance Win32_Process -Filter "ProcessId=$PID"
    $skip = @($PID, [int]$self.ParentProcessId)
    Get-CimInstance Win32_Process |
        Where-Object { $_.CommandLine -and $_.CommandLine.Contains($needle) -and $skip -notcontains [int]$_.ProcessId } |
        ForEach-Object {
            Write-Host "stopping $($_.ProcessId) $($_.Name)"
            Stop-Tree $_.ProcessId $_.CreationDate
        }

    # The caller's finally block did not run, so also drop the throwaway browser profile (tens of MB).
    $profileDir = Join-Path $needle 'browser-profile'
    for ($i = 0; $i -lt 20 -and (Test-Path -LiteralPath $profileDir); $i++) {
        if ($i) { Start-Sleep -Milliseconds 500 }
        Remove-Item -LiteralPath $profileDir -Recurse -Force -ErrorAction SilentlyContinue
    }
    if (Test-Path -LiteralPath $profileDir) { Write-Host "could not remove $profileDir" }
}

if ($ResetClock) {
    # The caller moved the emulator clock (time-travel.ps1 -Minutes) and could not put it back.
    Write-Host "resetting the emulator clock (EMU_SERIAL=$env:EMU_SERIAL)"
    try { & (Join-Path $PSScriptRoot 'time-travel.ps1') -Reset }
    catch { Write-Host "clock reset failed: $($_.Exception.Message). Run scripts\time-travel.ps1 -Reset by hand." }
}
