# Build a Unity player in batchmode (Android APK, WebGL folder or Windows exe).
# The project must not be open in another Editor (Unity locks the project folder).
#
#   build-unity.ps1 -ProjectPath sample\EmuSmoke -Target Android -Method EmuBuild.BuildApk
#   build-unity.ps1 -ProjectPath sample\EmuSmoke -Target WebGL -Method EmuBuild.BuildWebGL
#   build-unity.ps1 -ProjectPath sample\EmuSmoke -Target Windows -Method EmuBuild.BuildWindows
#   build-unity.ps1 -ProjectPath <p> -Target Android -Method EmuProjectBuild.BuildApk -EmuArm64
#   build-unity.ps1 -ProjectPath <p> -Target WebGL -BuildProfile "Assets/Settings/Build Profiles/Web.asset"
#
# -Method        : static editor method; receives "-buildOut <path>" (and "-apkOut <path>" for Android). It must
#                  write there (or pass -Out where it does write) and exit non-zero on failure (EditorApplication.Exit(1)).
# -BuildProfile  : Unity 6 build profile asset (uses -activeBuildProfile + -build, no code needed).
# -Out           : Android: the .apk file (one universal APK); WebGL: the folder; Windows: the .exe file (Unity puts
#                  <name>_Data, UnityPlayer.dll and the rest next to it). Default (Get-DefaultBuildOut, common.ps1):
#                  the sample builds into its own Builds\, any other project into artifacts\builds\<name>-<hash>\ here.
# -Release / -WebGLCompression : passed to the method as "-release" / "-webglCompression <x>" (EmuBuild reads them).
# -EmuArm64      : passed to the method as "-emuArm64" (EmuProjectBuild: IL2CPP + ARM64 for this build only).
# -ExtraArgs     : more method arguments. "powershell -File" cannot pass an array or a value that starts with "-",
#                  so call: powershell -NoProfile -ExecutionPolicy Bypass -Command "& .\scripts\build-unity.ps1 ... -ExtraArgs @('-name','value')"
# -TimeoutMinutes: Unity is stopped after this long (default 40). A stopped build does not restore the settings
#                  its method changed: run project-guard.ps1 -Mode Report afterwards.
# BUILD_OK is printed only when this build wrote the output; a file left at -Out by an earlier build does not count.
# If this PowerShell is killed (tool timeout, closed console), a watchdog stops the hidden Unity it started.
param(
    [Parameter(Mandatory)] [string]$ProjectPath,
    [ValidateSet('Android', 'WebGL', 'Windows')] [string]$Target = 'Android',
    [string]$Method,
    [string]$BuildProfile,
    [string]$Out,
    [switch]$Release,
    [ValidateSet('', 'brotli', 'gzip', 'disabled')] [string]$WebGLCompression = '',
    [string[]]$ExtraArgs = @(),
    [int]$TimeoutMinutes = 40,
    [switch]$EmuArm64
)
. "$PSScriptRoot\common.ps1"
# Format-QuotedArg (common.ps1): a path ending in "\" is quoted with its trailing backslashes doubled, else Windows
# reads \" as a literal quote and Unity gets one argument holding the rest of the line.

function Get-OutputStamp([string]$Target, [string]$Path) {
    # What is at the output: Android the .apk file (a folder does not count), WebGL the folder with an index.html,
    # Windows the .exe file plus its <name>_Data folder.
    # Time = newest LastWriteTime, Length = bytes, Count = files; $null when there is no output.
    # WebGL looks at every file: an incremental build rewrites only changed files (index.html often keeps an older
    # time), but the .data file was rewritten by every build seen, even when "player data was not rebuilt".
    if ($Target -eq 'Android') {
        if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
        $files = @(Get-Item -LiteralPath $Path)
    } elseif ($Target -eq 'Windows') {
        if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
        $files = @(Get-Item -LiteralPath $Path) + @(Get-ChildItem -LiteralPath (Get-WindowsDataDir $Path) -Recurse -File -ErrorAction SilentlyContinue)
    } else {
        if (-not (Test-Path -LiteralPath ([IO.Path]::Combine($Path, 'index.html')) -PathType Leaf)) { return $null }
        $files = @(Get-ChildItem -LiteralPath $Path -Recurse -File -ErrorAction SilentlyContinue)
    }
    $newest = [DateTime]::MinValue; $bytes = 0
    foreach ($f in $files) { if ($f.LastWriteTimeUtc -gt $newest) { $newest = $f.LastWriteTimeUtc }; $bytes += $f.Length }
    return [pscustomobject]@{ Time = $newest; Length = $bytes; Count = $files.Count }
}

foreach ($a in 'ProjectPath', 'Out', 'BuildProfile') { Assert-PathArg $a (Get-Variable $a -ValueOnly) }
$ProjectPath = Remove-TrailingSeparator (Resolve-Path -LiteralPath $ProjectPath).ProviderPath
if (-not $Method -and -not $BuildProfile) { throw 'Pass -Method or -BuildProfile.' }
if ($EmuArm64 -and ($Target -ne 'Android' -or -not $Method)) {
    throw '-EmuArm64 needs -Target Android and -Method: it is passed to the build method as -emuArm64 (EmuProjectBuild reads it).'
}
if ($WebGLCompression -and $Target -ne 'WebGL') { throw '-WebGLCompression is only for -Target WebGL.' }
$unity = Get-UnityEditorForProject $ProjectPath
if (-not $Out) { $Out = Get-DefaultBuildOut $ProjectPath $Target }
# Resolve against the PowerShell location ($PWD), not the process working directory.
$Out = Remove-TrailingSeparator $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Out)
if ($Target -eq 'Android') {
    if ([IO.Path]::GetExtension($Out) -ne '.apk') {
        throw "-Out must be an .apk file for Android (got $Out): the smoke test installs one universal APK, not an .aab or a folder."
    }
    if (Test-Path -LiteralPath $Out -PathType Container) {
        throw "-Out is a folder: $Out (an exported Gradle project from an earlier 'Export Project' build?). Pass another -Out, or ask the person before removing it."
    }
} elseif ($Target -eq 'Windows') {
    if ([IO.Path]::GetExtension($Out) -ne '.exe') {
        throw "-Out must be an .exe file for Windows (got $Out): Unity writes the player exe there and <name>_Data next to it."
    }
    if (Test-Path -LiteralPath $Out -PathType Container) { throw "-Out is a folder: $Out. Pass the .exe path, e.g. <folder>\app.exe." }
}

if (Test-ProjectLocked $ProjectPath) {
    $holders = @(Get-UnityProcessesForProject $ProjectPath)
    # An open Editor runs batchmode asset import workers (-name AssetImportWorker*) for the same project: not builds.
    $batch = @($holders | Where-Object { $_.Batchmode -and -not $_.Worker })
    if ($batch.Count) {
        $desc = ($batch | ForEach-Object {
            $started = '?'
            $p = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue
            if ($p) { try { $started = $p.StartTime.ToString('yyyy-MM-dd HH:mm:ss') } catch { } }
            "PID $($_.ProcessId), started $started"
        }) -join '; '
        throw ("A batchmode Unity is still building this project ($desc): a leftover build from an earlier run that was " +
            "cut off (tool timeout, closed console), or another run that is still going. No Editor needs closing. Wait for it " +
            "to exit, or, after the person agrees, stop it with Stop-Process -Id <pid>. A stopped build does not restore the " +
            "settings its method changed, so run scripts\project-guard.ps1 -ProjectPath <p> -Mode Report afterwards. Project: $ProjectPath")
    }
    $ids = @($holders | Where-Object { -not $_.Batchmode } | ForEach-Object { $_.ProcessId }) -join ', '
    # An Editor started without -projectPath on its command line still shows up as the parent of its import workers.
    if (-not $ids) { $ids = @($holders | Where-Object { $_.Worker -and $_.ParentProcessId } | ForEach-Object { $_.ParentProcessId } | Select-Object -Unique) -join ', ' }
    $who = if ($ids) { "a Unity Editor (PID $ids)" } else { 'a Unity Editor' }
    throw "Project is open in $($who): $ProjectPath. Ask the person to close it, or to build from that Editor and test the output with -SkipBuild."
}

$parent = if ($Target -eq 'WebGL') { $Out } else { [IO.Path]::GetDirectoryName($Out) }   # .apk / .exe: its folder
[void][IO.Directory]::CreateDirectory($parent)

$log = if ($Target -eq 'WebGL') { "$Out.build.log" } else { [IO.Path]::ChangeExtension($Out, '.build.log') }
# Unity's -buildTarget names: android, webgl, win64 (StandaloneWindows64).
$buildTargetArg = @{ Android = 'android'; WebGL = 'webgl'; Windows = 'win64' }[$Target]
$argList = @('-batchmode', '-quit', '-nographics', '-projectPath', (Format-QuotedArg $ProjectPath),
             '-buildTarget', $buildTargetArg, '-logFile', (Format-QuotedArg $log))
if ($Method) {
    $argList += @('-executeMethod', $Method, '-buildOut', (Format-QuotedArg $Out))
    if ($Target -eq 'Android') { $argList += @('-apkOut', (Format-QuotedArg $Out)) }
} else {
    $argList += @('-activeBuildProfile', (Format-QuotedArg $BuildProfile), '-build', (Format-QuotedArg $Out))
}
if ($Release) { $argList += '-release' }
if ($WebGLCompression) { $argList += @('-webglCompression', $WebGLCompression) }
if ($EmuArm64) { $argList += '-emuArm64' }
$argList += @($ExtraArgs | ForEach-Object { if ($_ -eq '' -or $_ -match '\s') { Format-QuotedArg $_ } else { $_ } })

# What is at -Out now tells an output of this build from one an earlier build left there (a method that fails
# without Exit(1), or writes to its own path, leaves the old output in place).
# An output inside this lab (artifacts\builds\, the sample's Builds\) is the lab's own: clear it first, so whatever is
# there afterwards was written by this build. A no-change incremental WebGL build otherwise rewrites nothing.
$outNorm = Get-NormalizedPath $Out
if ($outNorm.StartsWith((Get-NormalizedPath $RepoRoot) + '\', [StringComparison]::OrdinalIgnoreCase)) {
    # Windows: the exe and its <name>_Data folder only. Their folder may hold other things (any -Out the caller picked).
    $clear = @($Out)
    if ($Target -eq 'Windows') { $clear += Get-WindowsDataDir $Out }
    foreach ($c in $clear) {
        if (Test-Path -LiteralPath $c) { Remove-Item -LiteralPath $c -Recurse -Force; Write-Host "Cleared the previous lab output at $c" }
    }
}
$before = Get-OutputStamp $Target $Out

Write-Host "Unity $($unity.Version) [$Target] -> $Out"
$startUtc = [DateTime]::UtcNow
$sw = [Diagnostics.Stopwatch]::StartNew()
$proc = Start-Process -FilePath $unity.Exe -ArgumentList $argList -PassThru -WindowStyle Hidden
[void]$proc.Handle   # keeps ExitCode readable and the PID ours until we are done
$watchdog = $null
$finished = $false
try {
    # If this PowerShell is killed before the finally block runs (agent tool timeout, closed console), the
    # watchdog stops the hidden Unity so it does not keep building and holding Temp\UnityLockfile.
    $watchLog = $log -replace '\.build\.log$', '.watchdog.log'
    try {
        $watchdog = Start-Detached 'powershell.exe' @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
            (Join-Path $PSScriptRoot 'watch-parent.ps1'), '-ParentPid', "$PID", '-ChildPid', "$($proc.Id)") $watchLog $null
    } catch {
        Write-Host "WARN no watchdog for Unity PID $($proc.Id) ($($_.Exception.Message)); if this run is cut off, stop that PID by hand."
    }
    # Wait in 1 s slices: one long WaitForExit cannot be interrupted by Ctrl+C / a pipeline stop in PS 5.1.
    $limitMs = [int64]$TimeoutMinutes * 60 * 1000
    while (-not $proc.WaitForExit(1000)) {
        if ($sw.ElapsedMilliseconds -ge $limitMs) {
            throw ("Unity build timed out after $TimeoutMinutes min and was stopped (a first IL2CPP build of a big project " +
                "can need a larger -TimeoutMinutes). Its method could not restore the settings it changed: run " +
                "scripts\project-guard.ps1 -ProjectPath '$ProjectPath' -Mode Report now. Log: $log")
        }
    }
    $finished = $true
} finally {
    if (-not $finished -and -not $proc.HasExited) {
        Write-Host "Stopping Unity PID $($proc.Id) and its child processes"
        Stop-ProcessTree $proc.Id
    }
    if ($watchdog) { Stop-ProcessTree $watchdog.Id }
}
$sw.Stop()

$hits = @()
if (Test-Path -LiteralPath $log -PathType Leaf) {
    $hits = @(Select-String -LiteralPath $log -Pattern 'EMU_BUILD_[A-Z]+|Build Finished, Result: \w+|error CS\d+')
}
# EMU_BUILD_WARN / EMU_BUILD_NOTE (EmuProjectBuild): debug keystore, Addressables, settings it turned off.
$hits | Where-Object { $_.Line -match 'EMU_BUILD_(WARN|NOTE)' } | ForEach-Object { $_.Line.Trim() } |
    Select-Object -Unique | ForEach-Object { Write-Host $_ }
$hits | Where-Object { $_.Line -notmatch 'EMU_BUILD_(WARN|NOTE)' } | Select-Object -Last 5 | ForEach-Object { Write-Host $_.Line }
function Get-BuildErrorSummary {
    # The first few lines that say why (UnityException + its message line, compile errors, build exceptions).
    if (-not (Test-Path -LiteralPath $log -PathType Leaf)) { return '' }
    $lines = [IO.File]::ReadAllLines($log)
    $picked = New-Object System.Collections.Generic.List[string]
    for ($i = 0; $i -lt $lines.Count -and $picked.Count -lt 4; $i++) {
        $s = $lines[$i].Trim()
        if ($s -match '^(UnityException|BuildFailedException|System\.\w+Exception|Error building Player|.*error CS\d+|C/C\+\+: CMake Error|\* What went wrong)') {
            if (-not $picked.Contains($s)) { $picked.Add($s) }
            # These put the actual message on the next line.
            if ($s -match '^(UnityException|C/C\+\+: CMake Error|\* What went wrong)' -and $i + 1 -lt $lines.Count -and $lines[$i + 1].Trim()) {
                $next = $lines[$i + 1].Trim(); if (-not $picked.Contains($next)) { $picked.Add($next) }
            }
        }
    }
    if ($picked.Count) { return ' Reason: ' + (($picked | ForEach-Object { if ($_.Length -gt 300) { $_.Substring(0, 300) } else { $_ } }) -join ' | ') }
    return ''
}
if ($proc.ExitCode -ne 0) {
    throw "Unity build failed (exit $($proc.ExitCode)).$(Get-BuildErrorSummary) Log: $log"
}

# Exit code 0 is not enough: a project's own method may log a failed BuildReport and return normally.
$lastFinished = @($hits | Where-Object { $_.Line -match 'Build Finished, Result: \w+' }) | Select-Object -Last 1
$lastResult = @($hits | Where-Object { $_.Line -match 'EMU_BUILD_RESULT \w+' }) | Select-Object -Last 1
$failLine = $null
if ($lastFinished -and $lastFinished.Line -notmatch 'Result: Success') { $failLine = $lastFinished.Line }
elseif ($lastResult -and $lastResult.Line -notmatch 'EMU_BUILD_RESULT Succeeded') { $failLine = $lastResult.Line }
if ($failLine) {
    throw "Unity exited 0 but the log reports a failed build ($($failLine.Trim())): the build method returned without EditorApplication.Exit(1). Errors are in $log"
}

# Written by this build: newer than its start, or different from before (Unity copies the APK with the Gradle
# output's timestamp), or nothing there before.
$after = Get-OutputStamp $Target $Out
$fresh = $after -and (-not $before -or $after.Time -ge $startUtc -or $after.Time -ne $before.Time -or
                      $after.Length -ne $before.Length -or $after.Count -ne $before.Count)
$unchanged = $false
if (-not $fresh -and $after -and $lastResult -and $lastResult.Line -match 'EMU_BUILD_RESULT Succeeded .*\bout=(.+)$') {
    # EmuBuild / EmuProjectBuild name the path they built to: a no-change incremental build of that same path is fine.
    if (Test-SamePath $Matches[1].Trim() $Out) { $fresh = $true; $unchanged = $true }
}
if (-not $fresh) {
    if ($Target -eq 'Android' -and (Test-Path -LiteralPath $Out -PathType Container)) {
        throw ("Unity exited 0 but wrote a folder at $Out, not an APK: 'Export Project' (EditorUserBuildSettings." +
            "exportAsGoogleAndroidProject) is on. EmuProjectBuild turns it off for its build; with the project's own method " +
            "or a build profile, ask the person to turn it off for this build. Log: $log")
    }
    $old = if ($after) { $after.Time.ToLocalTime().ToString('yyyy-MM-dd HH:mm:ss') } else { '' }
    if ($Target -eq 'WebGL') {
        $what = if ($after) { "nothing in $Out was written by this build (newest file from $old, before it started): an earlier build left it" } else { "there is no index.html in $Out" }
    } elseif ($Target -eq 'Windows') {
        $what = if ($after) { "the exe at $Out and its $([IO.Path]::GetFileName((Get-WindowsDataDir $Out))) folder are from $old, before this build started: an earlier build left them" } else { "nothing was written at $Out" }
    } else {
        $what = if ($after) { "the APK at $Out is from $old, before this build started: an earlier build left it" } else { "nothing was written at $Out" }
    }
    $why = 'The build may have failed without EditorApplication.Exit(1), or the method writes its own path (ignoring -buildOut/-apkOut).'
    if ($lastFinished) { $why = 'The log says the build succeeded, so the method most likely writes to its own path (ignoring -buildOut/-apkOut).' }
    if ($Target -eq 'Windows') {
        $others = @(Get-ChildItem -LiteralPath $parent -Filter '*.exe' -File -ErrorAction SilentlyContinue |
            Where-Object { $_.LastWriteTimeUtc -ge $startUtc -and $_.FullName -ne $Out -and $_.Name -notmatch '^UnityCrashHandler' } | ForEach-Object { $_.Name })
        if ($others.Count) { $why = "Unity wrote $($others -join ', ') in $parent instead: the method picks its own exe name. Pass that path as -Out." }
    }
    if ($Target -eq 'Android') {
        $others = @(Get-ChildItem -LiteralPath $parent -File -ErrorAction SilentlyContinue |
            Where-Object { $_.Extension -match '^\.(apk|aab)$' -and $_.LastWriteTimeUtc -ge $startUtc -and $_.FullName -ne $Out } |
            ForEach-Object { $_.Name })
        if ($others.Count) {
            $why = ("Unity wrote $($others -join ', ') in $parent instead: 'Split APKs by target architecture' (one APK per ABI) " +
                "or 'Build App Bundle' (.aab) is on, or the method picks its own file name. The test needs one universal .apk " +
                "at -Out; EmuProjectBuild turns both off for its build.")
        }
    }
    $where = "Find where the method really writes in $log and pass that path as -Out, or pass the method's own output argument through -ExtraArgs with the same absolute path as -Out."
    throw "Unity exited 0 but $what. $why $where"
}

if ($Target -eq 'Windows' -and -not (Test-Path -LiteralPath (Get-WindowsDataDir $Out) -PathType Container)) {
    throw "Unity wrote $Out but no $([IO.Path]::GetFileName((Get-WindowsDataDir $Out))) folder next to it, so the player cannot start. Errors are in $log"
}
$note = if ($unchanged) { ', unchanged: incremental build with nothing to rewrite' } else { '' }
Write-Host ("BUILD_OK {0} ({1} MB, {2:N0}s{3})" -f $Out, [math]::Round($after.Length / 1MB, 1), $sw.Elapsed.TotalSeconds, $note)
