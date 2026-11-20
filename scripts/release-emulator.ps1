# Give the test AVD back when you are done (the other half of start-emulator.ps1):
#   1) reset what test runs leave on the device: Firebase Analytics debug mode (debug.firebase.analytics.app),
#      its verbose log tags (log.tag.FA, log.tag.FA-SVC), a clock left ahead by time travel
#   2) -Uninstall: remove the apps installed under this lease (smoke-test.ps1 records them), with their data
#   3) stop the emulator only if this lease started it (one that was already running stays up)
#   4) delete the lease, so the next session can take the device
#
#   release-emulator.ps1                 # owner = this session (EMU_OWNER, Claude Code / Codex session, else user@host)
#   release-emulator.ps1 -Uninstall      # also uninstall the apps this lease installed
#   release-emulator.ps1 -Uninstall -Package com.example.app   # uninstall this package instead (one per -File call)
#   release-emulator.ps1 -KeepRunning    # leave the emulator up even if this lease started it
#   release-emulator.ps1 -AnyOwner       # the person only: release someone else's lease (same steps)
#   release-emulator.ps1 -Stale          # the person only: drop a lease that ran out; the device is not touched
# Exit 0 released (or nothing to release), 1 refused or failed (NOT_OWNER, NOT_STALE, ...).
param(
    [string]$AvdName = 'unity-test',
    [string]$Owner,
    [switch]$Uninstall,
    [string[]]$Package,
    [switch]$KeepRunning,
    [switch]$AnyOwner,
    [switch]$Stale
)
$ErrorActionPreference = 'Stop'
if ($args.Count) { throw "Unknown option(s): $($args -join ' ')" }
. "$PSScriptRoot\common.ps1"

if ($Stale -and $AnyOwner) { throw 'Pass -Stale or -AnyOwner, not both.' }
if ($Stale -and ($Uninstall -or $KeepRunning)) { throw '-Stale only drops the lease file and does not touch the device; drop -Uninstall / -KeepRunning.' }
# powershell -File passes "a,b" as one string.
$Package = @($Package | ForEach-Object { "$_" -split ',' } | ForEach-Object { $_.Trim() } | Where-Object { $_ })
if ($Package.Count -and -not $Uninstall) { throw '-Package names what -Uninstall removes; add -Uninstall.' }
if (-not $Owner) { $Owner = Get-EmuOwner }
$env:EMU_AVD = $AvdName

$leasePath = Get-EmuLeasePath $AvdName
$lease = Read-EmuLease $AvdName
if (-not $lease) {
    Write-Host "LEASE_NONE AVD '$AvdName' has no lease ($leasePath): nothing to release."
    exit 0
}
if ($Stale) {
    if (Test-EmuLeaseValid $lease) { throw "NOT_STALE the lease of $($lease.owner) is valid until $($lease.expiresAt). -Stale drops only a lease that ran out." }
    Remove-Item -LiteralPath $leasePath -Force
    Write-Host "RELEASED stale lease of $($lease.owner) (ran out at $($lease.expiresAt)); the device was not touched"
    exit 0
}
if ($lease.owner -ne $Owner -and -not $AnyOwner) {
    throw "NOT_OWNER AVD '$AvdName' is leased by $($lease.owner), not by $Owner. Leave it: another session may still be testing. Only the person releases it (release-emulator.ps1 -AnyOwner)."
}

Start-AdbServer
$serial = Get-EmulatorSerial -AvdName $AvdName -WaitSec 10
if ($serial) {
    $env:EMU_SERIAL = $serial
    # Firebase Analytics debug mode stays on until it is turned off (quick-boot snapshots keep it too).
    $fb = ((Invoke-Adb shell getprop debug.firebase.analytics.app) -join '').Trim()
    if ($fb -and $fb -ne '.none.') {
        Invoke-Adb shell setprop debug.firebase.analytics.app .none. | Out-Null
        Write-Host "RESET debug.firebase.analytics.app $fb -> .none."
    }
    foreach ($tag in 'log.tag.FA', 'log.tag.FA-SVC') {
        $v = ((Invoke-Adb shell getprop $tag) -join '').Trim()
        if ($v) {
            # One argument: the device shell then reads '' as an empty value.
            Invoke-Adb shell "setprop $tag ''" | Out-Null
            Write-Host "RESET $tag $v -> (empty)"
        }
    }
    if (((Invoke-Adb shell settings get global auto_time) -join '').Trim() -eq '0') {
        Write-Host 'TIME_RESET auto_time was 0 (time travel did not finish): restoring the device clock'
        & "$PSScriptRoot\time-travel.ps1" -Reset
    }

    $recorded = @(@($lease.installed) | Where-Object { $_ })
    if ($Uninstall) {
        $targets = @(if ($Package.Count) { $Package } else { $recorded })
        if (-not $targets.Count) { Write-Host 'UNINSTALL nothing: no app was installed under this lease (name one with -Package <id>)' }
        foreach ($p in $targets) {
            $out = ((Invoke-Adb uninstall $p) -join ' ').Trim()
            Write-Host "UNINSTALL $p $out"
        }
    } elseif ($recorded.Count) {
        Write-Host "KEPT apps $($recorded -join ', ') with their data: the next run on this device is not a first run (-Uninstall removes them)"
    }
} else {
    Write-Host "EMULATOR_NOT_RUNNING AVD '$AvdName': nothing to reset on the device"
}

if ($serial -and $lease.startedEmulator -and -not $KeepRunning) {
    # Stop only the instance this lease started: same pid and start time as start-emulator.ps1 recorded.
    $q = $null
    if ($lease.emulatorPid) { $q = Get-Process -Id ([int]$lease.emulatorPid) -ErrorAction SilentlyContinue }
    $same = $false
    if ($q -and $q.ProcessName -eq 'qemu-system-x86_64') {
        $same = $true
        if ($lease.emulatorStartedAt) {
            try { $same = [Math]::Abs((([DateTimeOffset]$q.StartTime) - (ConvertTo-LeaseDate $lease.emulatorStartedAt)).TotalSeconds) -lt 2 } catch { $same = $false }
        }
    }
    if ($same) {
        Invoke-Adb emu kill | Out-Null
        # It saves the quick-boot snapshot before it exits (about 20 s).
        $deadline = (Get-Date).AddSeconds(90)
        while ((Get-Process -Id $q.Id -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) { Start-Sleep -Seconds 2 }
        if (Get-Process -Id $q.Id -ErrorAction SilentlyContinue) {
            Write-Host "STOP_PENDING emulator $serial is still saving its state after 90 s; it exits by itself"
        } else {
            Write-Host "STOPPED emulator $serial (this lease started it)"
        }
    } else {
        Write-Host "KEPT_RUNNING emulator $serial is not the instance this lease started (pid $($lease.emulatorPid)); leaving it"
    }
} elseif ($serial) {
    $why = if ($KeepRunning) { '-KeepRunning' } else { 'it was already running when the lease was taken' }
    Write-Host "KEPT_RUNNING emulator $serial ($why)"
}

Remove-Item -LiteralPath $leasePath -Force
$by = if ($lease.owner -ne $Owner) { " by $Owner (-AnyOwner)" } else { '' }
Write-Host "RELEASED avd=$AvdName owner=$($lease.owner)$by"
