# Take the lease on the test AVD, boot it (windowed by default so a person can watch) and wait until it is usable.
# One session at a time: another owner's valid lease stops this script (BUSY) before it touches anything.
# Running it again as the same owner renews the lease and reuses the running emulator. Give the device back with
# release-emulator.ps1 when done.
# Audio is off by default (-no-audio); pass -Audio only when you really need sound.
#
#   start-emulator.ps1                 # windowed, quick boot from snapshot
#   start-emulator.ps1 -Headless       # no window (CI style)
#   start-emulator.ps1 -ColdBoot       # ignore the quick-boot snapshot
#   start-emulator.ps1 -Hours 8        # a longer lease (default 4 h)
# Owner: -Owner, else EMU_OWNER, else the Claude Code / Codex session, else user@host (common.ps1 Get-EmuOwner).
param(
    [string]$AvdName = 'unity-test',
    [switch]$Headless,
    [switch]$ColdBoot,
    [switch]$Audio,
    [int]$BootTimeoutSec = 300,
    [string]$Owner,
    [double]$Hours = 4
)
. "$PSScriptRoot\common.ps1"
# The emulator and adb need only the Android variables; JAVA_HOME is a bonus for later steps in this process.
# Without any JDK (no bundled Unity OpenJDK, External Tools JDK or JAVA_HOME) still set the Android variables.
try { Use-UnityJdk } catch { Set-AndroidEnv }
# Name the folders when something is missing: a SDK/AVD location chosen earlier but not visible to this shell
# otherwise shows up only as "adb.exe is not recognized" or "Emulator exited right away".
if (-not (Test-Path -LiteralPath $Adb)) {
    throw "No adb at $Adb (from $AdbSource). Run scripts\doctor.ps1 -Target Android; install the SDK with setup-android-sdk.ps1 only after the license consent."
}
if ($Hours -le 0) { throw '-Hours must be more than 0.' }

$env:EMU_AVD = $AvdName   # later scripts in this process target the same AVD
if (-not $Owner) { $Owner = Get-EmuOwner }
# Lease first: while another session holds the device, change nothing (no adb server start, no boot, no settings).
$take = Enter-EmuLease -Owner $Owner -Hours $Hours -Avd $AvdName
Write-Host "LEASE $($take.Action) avd=$AvdName owner=$Owner until=$($take.Lease.expiresAt) file=$(Get-EmuLeasePath $AvdName)"
$launched = $false

try {
    Start-AdbServer

    function Assert-NoOtherEmulator {
        # Only AVD $AvdName is ever touched (settings, clock, permissions). Another emulator, e.g. a personal
        # Android Studio AVD, is left alone: stop and let the person close it.
        $others = @(Get-RunningEmulators | Where-Object { $_.Avd -ne $AvdName })
        if ($others.Count) {
            $list = ($others | ForEach-Object { "$($_.Serial)=$($_.Avd)" }) -join ', '
            throw "Other emulator(s) running: $list. This repo only touches AVD '$AvdName' and will not change them. Close them (Android Studio > Device Manager > Stop) and run again."
        }
    }

    # If an emulator process is already up, give it time to re-attach to a freshly started adb server
    # instead of launching a second instance of the same AVD.
    $alreadyUp = [bool](Get-Process qemu-system-x86_64 -ErrorAction SilentlyContinue)
    $serial = Get-EmulatorSerial -AvdName $AvdName
    if (-not $serial -and $alreadyUp) {
        Assert-NoOtherEmulator
        $serial = Get-EmulatorSerial -WaitSec 30 -AvdName $AvdName
        if (-not $serial) { Assert-NoOtherEmulator }
    }
    if ($serial) {
        $how = if ($take.Lease.startedEmulator) { 'started under this lease' } else { 'it stays running after release-emulator.ps1' }
        Write-Host "Emulator already running: $serial ($how)"
    } else {
        if (-not (Test-Path -LiteralPath $EmulatorExe)) {
            throw "No emulator at $EmulatorExe (SDK root from $SdkRootSource). Run scripts\doctor.ps1 -Target Android; install the SDK with setup-android-sdk.ps1 only after the license consent."
        }
        $avdIni = [IO.Path]::Combine($AvdHome, "$AvdName.ini")
        if (-not (Test-Path -LiteralPath $avdIni)) {
            throw "AVD '$AvdName' not found: no $avdIni (AVD home from $AvdHomeSource). Run scripts\doctor.ps1 -Target Android; setup-android-sdk.ps1 creates the AVD."
        }
        $emuArgs = @('-avd', $AvdName, '-no-boot-anim', '-gpu', 'host')
        if (-not $Audio) { $emuArgs += '-no-audio' }
        if ($Headless) { $emuArgs += '-no-window' }
        if ($ColdBoot) { $emuArgs += '-no-snapshot-load' }
        # A previous emulator.exe can linger ~20 s after "emu kill" while it saves state; it still holds the AVD
        # lock and its log files, and a new instance started meanwhile dies at once.
        $lingerDeadline = (Get-Date).AddSeconds(60)
        while ((Get-Process emulator, qemu-system-x86_64 -ErrorAction SilentlyContinue) -and (Get-Date) -lt $lingerDeadline) {
            Start-Sleep -Seconds 2
        }
        $logDir = Join-Path $RepoRoot 'artifacts\emulator'
        New-Item -ItemType Directory -Force $logDir | Out-Null
        $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
        $launcher = Start-Detached $EmulatorExe $emuArgs (Join-Path $logDir "$stamp.out.log") (Join-Path $logDir "$stamp.err.log")
        $launched = $true
        # release-emulator.ps1 stops only an emulator this lease started.
        [void](Update-EmuLease @{ startedEmulator = $true; emulatorPid = $null; emulatorStartedAt = $null } -Owner $Owner -Avd $AvdName)
        Write-Host "Starting $AvdName ($($emuArgs -join ' ')) log=$logDir\$stamp.*.log"
        Start-Sleep -Seconds 5
        if ($launcher.HasExited) { throw "Emulator exited right away (cmd exit $($launcher.ExitCode)). See $logDir\$stamp.err.log" }
    }

    $deadline = (Get-Date).AddSeconds($BootTimeoutSec)
    while (-not ($serial = Get-EmulatorSerial -AvdName $AvdName)) {
        if ((Get-Date) -gt $deadline) { throw 'Emulator did not show up in adb devices.' }
        Start-Sleep -Seconds 2
    }
    $env:EMU_SERIAL = $serial
    if ($launched) {
        # The process release-emulator.ps1 may stop later: the newest qemu, checked again by pid + start time then.
        $q = @(Get-Process qemu-system-x86_64 -ErrorAction SilentlyContinue | Sort-Object StartTime -Descending) | Select-Object -First 1
        if ($q) { [void](Update-EmuLease @{ emulatorPid = $q.Id; emulatorStartedAt = ([DateTimeOffset]$q.StartTime).ToString('o') } -Owner $Owner -Avd $AvdName) }
    }
    while ((Invoke-Adb shell getprop sys.boot_completed 2>$null) -ne '1') {
        if ((Get-Date) -gt $deadline) { throw "Emulator $serial did not finish booting." }
        Start-Sleep -Seconds 2
    }

    # Make the device predictable for automation.
    Invoke-Adb shell settings put global window_animation_scale 0
    Invoke-Adb shell settings put global transition_animation_scale 0
    Invoke-Adb shell settings put global animator_duration_scale 0
    Invoke-Adb shell settings put system screen_off_timeout 1800000
    Invoke-Adb shell svc power stayon true
    # Skip the first-run "Viewing full screen" hint: it steals focus and Unity waits for focus before its first frame.
    Invoke-Adb shell settings put secure immersive_mode_confirmations confirmed
    Invoke-Adb shell input keyevent KEYCODE_WAKEUP
    Invoke-Adb shell wm dismiss-keyguard
    # A run killed during time travel (smoke-test -TimeTravelMinutes) can leave the clock ahead with auto_time off.
    if (((Invoke-Adb shell settings get global auto_time) -join '').Trim() -eq '0') {
        Write-Host 'TIME_RESET auto_time was 0 (an earlier time-travel run did not finish): restoring the device clock'
        & "$PSScriptRoot\time-travel.ps1" -Reset
    }
} catch {
    # A lease this call took is given back when the start fails, unless this call launched an emulator:
    # then the lease stays so that release-emulator.ps1 can stop it.
    if ($take.Action -ne 'renewed' -and -not $launched) {
        Remove-Item -LiteralPath (Get-EmuLeasePath $AvdName) -Force -ErrorAction SilentlyContinue
        Write-Host "LEASE given back (start failed)"
    } elseif ($launched) {
        Write-Host "LEASE kept: this call launched the emulator; run scripts\release-emulator.ps1 to stop it"
    }
    throw
}

$abis = Invoke-Adb shell getprop ro.product.cpu.abilist
$bridge = Invoke-Adb shell getprop ro.dalvik.vm.native.bridge
$release = Invoke-Adb shell getprop ro.build.version.release
Write-Host "EMULATOR_READY serial=$serial android=$release abilist=$abis native_bridge=$bridge owner=$Owner"
Write-Host 'next    when done: scripts\release-emulator.ps1 (-Uninstall also removes the apps installed under this lease)'
