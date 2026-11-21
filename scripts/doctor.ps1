# Pre-flight check for this lab on a new PC. Changes nothing; prints one line per check:
#   [OK]    ready
#   [TODO]  an agent can do it, after the person agrees (e.g. install the Android SDK = accept its license)
#   [HUMAN] only the person can do it (admin rights, BIOS, Unity Hub install, reboot, a choice to make)
#   [WARN]  works, but read the note
#   [FAIL]  blocks a target
#   [INFO]  for reference
# Exit code: 0 = ready, 2 = only TODO items left, 1 = HUMAN or FAIL items left.
#
#   doctor.ps1 -Target Android                                  # machine + bundled sample
#   doctor.ps1 -ProjectPath <unity project> -Target WebGL        # also the person's project
#   doctor.ps1 -ProjectPath <p> -Target Android -NoSample        # skip the sample check
#   doctor.ps1 -ProjectPath <p> -Target Windows                  # Windows player (exe) on this desktop
# Pass only the target(s) the person uses: 'Both' (default) = Android and WebGL, and also requires the WebGL module.
param(
    [string]$ProjectPath,
    [ValidateSet('Android', 'WebGL', 'Windows', 'Both')] [string]$Target = 'Both',
    [switch]$NoSample
)
. "$PSScriptRoot\common.ps1"
$ErrorActionPreference = 'Continue'

$script:results = New-Object Collections.ArrayList
function Add-Result([string]$Status, [string]$Key, [string]$Message) {
    [void]$script:results.Add([pscustomobject]@{ Status = $Status; Key = $Key; Message = $Message })
    Write-Host ("[{0}] {1}: {2}" -f $Status, $Key, $Message)
}
$wantAndroid = $Target -in 'Android', 'Both'
$wantWebGL = $Target -in 'WebGL', 'Both'
$wantWindows = $Target -eq 'Windows'
$targetText = if ($Target -eq 'Both') { 'Android and WebGL' } else { $Target }
$onlyOneHint = if ($Target -eq 'Both') { ' If you use only one platform, rerun with -Target Android, -Target WebGL or -Target Windows.' } else { '' }
$moveHint = 'setup-android-sdk.ps1 -SdkRoot <dir> -AvdHome <dir> puts them elsewhere for this lab (saved in local.settings.json, used by every later command; the person picks the folders)'

$script:externalNoted = @{}
function Add-ExternalToolsNote([string]$EditorPath, [string]$Version) {
    # Bundled parts that Unity > Preferences > External Tools replaces: accepted, but say so once per editor.
    $covered = @(Get-UnityAndroidMissing $EditorPath -BundledOnly | Where-Object { @(Get-UnityAndroidMissing $EditorPath) -notcontains $_ })
    if (-not $covered.Count -or $script:externalNoted.ContainsKey($Version)) { return }
    $script:externalNoted[$Version] = $true
    $ext = Get-UnityExternalAndroidTools
    $where = @()
    if ($covered -contains 'OpenJDK') { $where += "JDK $($ext.Jdk)" }
    if ($covered -like 'SDK *') { $where += "Android SDK $($ext.Sdk)" }
    if ($covered -contains 'NDK') { $where += "NDK $($ext.Ndk)" }
    Add-Result 'WARN' 'external-tools' "Unity $Version lacks the bundled $($covered -join ', '), but Unity > Preferences > External Tools points at $($where -join '; '): accepted, builds use those (the setting is shared by every Unity version). Build errors about them are tool-version problems, not missing Hub modules."
}

function Get-ModuleGaps([string]$EditorPath, [string]$Version, [string]$WindowsBackend = 'Mono') {
    # Modules this run needs that the editor lacks, as readable names. $WindowsBackend: the project's Windows scripting
    # backend (IL2CPP needs its own module).
    $pe = Join-Path $EditorPath 'Editor\Data\PlaybackEngines'
    $gaps = @()
    if ($wantAndroid) {
        $miss = @(Get-UnityAndroidMissing $EditorPath)
        if ($miss) { $gaps += "Android Build Support (missing $($miss -join ', '))" }
        Add-ExternalToolsNote $EditorPath $Version
    }
    if ($wantWebGL -and -not (Test-Path -LiteralPath (Join-Path $pe 'WebGLSupport'))) { $gaps += 'WebGL Build Support' }
    if ($wantWindows) { $gaps += @(Get-UnityWindowsMissing $EditorPath $WindowsBackend) }
    return $gaps
}

function Test-PathInside([string]$Inner, [string]$Outer) {
    # $Inner is $Outer or below it (full paths, case-insensitive).
    $i = Get-NormalizedPath $Inner; $o = Get-NormalizedPath $Outer
    return [string]::Equals($i, $o, [StringComparison]::OrdinalIgnoreCase) -or $i.StartsWith($o + '\', [StringComparison]::OrdinalIgnoreCase)
}

# --- OS / shell
$os = Get-CimInstance Win32_OperatingSystem
Add-Result 'INFO' 'os' "$($os.Caption) $($os.Version), PowerShell $($PSVersionTable.PSVersion)"
$ramGb = [math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1GB)
Add-Result $(if ($ramGb -ge 16) { 'OK' } else { 'WARN' }) 'ram' "$ramGb GB (16 GB or more recommended for the emulator plus Unity)"

# --- Packaged (MSIX) host: AppData writes are redirected and invisible to normal terminals.
# The shell itself has no package identity in that case, so test the redirection directly.
$probe = "emu-lab-probe-$([guid]::NewGuid().ToString('N')).txt"
try {
    [IO.File]::WriteAllText([IO.Path]::Combine($env:LOCALAPPDATA, $probe), 'probe')
    $redirect = Get-ChildItem -LiteralPath (Join-Path $env:LOCALAPPDATA 'Packages') -Directory -ErrorAction SilentlyContinue |
        Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName "LocalCache\Local\$probe") } | Select-Object -First 1
    if ($redirect) {
        $winNote = if ($wantWindows) { ' A Windows player started from here may also keep its PlayerPrefs (HKCU) and crash folders (%TEMP%) in that private copy.' } else { '' }
        Add-Result 'WARN' 'packaged-host' "this shell runs inside the packaged app '$($redirect.Name)': files it writes under %LOCALAPPDATA% / %APPDATA% go to that app's private folder and do not exist for other terminals. Keep installs outside AppData (the SDK default already is) and do the final check in a normal terminal.$winNote"
    }
} catch { } finally { Remove-Item -LiteralPath (Join-Path $env:LOCALAPPDATA $probe) -ErrorAction SilentlyContinue }

# --- Lab settings and network
if ($LocalSettingsError) {
    Add-Result 'FAIL' 'local-settings' "$LocalSettingsError. It holds the SDK / AVD folders chosen with setup-android-sdk.ps1 -SdkRoot / -AvdHome; fix the JSON (e.g. {`"sdkRoot`": `"C:\\Android\\Sdk`"}) or delete the file to use the defaults."
}
try {
    $px = Get-ProxySetting
    if ($px) {
        $auth = if ($px.HasAuth) { ' The proxy URL has a user name/password, which sdkmanager cannot take on its command line.' } else { '' }
        Add-Result 'INFO' 'proxy' "$($px.From) = $($px.Host):$($px.Port): setup-android-sdk.ps1 passes it to sdkmanager (--proxy=http); -Proxy host:port overrides it.$auth"
    }
} catch { Add-Result 'WARN' 'proxy' "$($_.Exception.Message) setup-android-sdk.ps1 would refuse it; pass -Proxy host:port." }

# --- Windows on ARM: the lab's Android path is an x86_64 emulator + x86_64 system image.
$armHost = Test-Arm64Host
$androidHost = $wantAndroid -and -not $armHost
if ($wantAndroid -and $armHost) {
    Add-Result 'FAIL' 'android-host' 'Windows on ARM (ARM64): the x86_64 Android emulator and system image this lab uses cannot run accelerated here, so the Android target is not supported on this PC. Do not install the Android SDK for it. -Target WebGL still works; test Android on a real device.'
}

# --- Virtualization for the Android emulator
$cs = Get-CimInstance Win32_ComputerSystem
$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
if ($androidHost) {
    $accel = $null
    if (Test-Path -LiteralPath $EmulatorExe) { $accel = (& $EmulatorExe -accel-check 2>&1 | ForEach-Object { "$_" }) -join ' ' }
    if ($accel -match $AccelOkPattern) {
        Add-Result 'OK' 'emulator-accel' $Matches[0]
    } elseif ($accel) {
        Add-Result 'HUMAN' 'emulator-accel' "no usable hypervisor: $($accel.Trim()). $(Get-AccelAdvice)."
    } elseif ($cs.HypervisorPresent -or $cpu.VirtualizationFirmwareEnabled) {
        Add-Result 'INFO' 'emulator-accel' "CPU virtualization is on (hypervisor present: $($cs.HypervisorPresent)); 'emulator -accel-check' runs after the SDK install."
    } else {
        Add-Result 'HUMAN' 'emulator-accel' 'CPU virtualization looks off: enable Intel VT-x / AMD-V in BIOS/UEFI and the Windows feature "Windows Hypervisor Platform" (admin, reboot).'
    }
}

# --- Unity editors and modules
$installs = @(Get-UnityInstalls)
if (-not $installs) {
    Add-Result 'HUMAN' 'unity' 'no Unity editor found. Install one with Unity Hub (or set UNITY_EDITOR_ROOT to the folder that holds the version folders).'
} else {
    foreach ($i in @(Get-UnityInstalls -IncludeShadowed)) {
        if ($i.Shadowed) {
            Add-Result 'INFO' "unity $($i.Version)" "second copy at $($i.Path) ($($i.Source)) is not used: $($i.UsedPath) comes first (UNITY_EDITOR_ROOT, Hub install location, default location, Hub Locate)"
            continue
        }
        $pe = Join-Path $i.Path 'Editor\Data\PlaybackEngines'
        $missB = @(Get-UnityAndroidMissing $i.Path -BundledOnly)
        $miss = @(Get-UnityAndroidMissing $i.Path)
        $android = if (-not (Test-Path -LiteralPath (Join-Path $pe 'AndroidPlayer'))) { 'no' } elseif ($miss) { "partial (missing $($miss -join ', '))" } elseif ($missB) { "yes via External Tools (bundled $($missB -join ', ') not installed)" } else { 'yes' }
        $jdk = if ($missB -notcontains 'OpenJDK') { Get-JdkMajor (Join-Path $pe 'AndroidPlayer\OpenJDK') } else { 0 }
        $webgl = Test-Path -LiteralPath (Join-Path $pe 'WebGLSupport')
        $winParts = @()
        if (-not @(Get-UnityWindowsMissing $i.Path 'Mono').Count) { $winParts += 'Mono' }
        if (-not @(Get-UnityWindowsMissing $i.Path 'IL2CPP' | Where-Object { $_ -like '*IL2CPP*' }).Count) { $winParts += 'IL2CPP' }
        $windows = if ($winParts) { $winParts -join '+' } else { 'no' }
        Add-Result 'INFO' "unity $($i.Version)" "Android=$android$(if ($jdk) { " (JDK $jdk)" }) WebGL=$webgl Windows=$windows ($($i.Path))"
    }
    if ($wantAndroid -and -not ($installs | Where-Object { (Get-UnityAndroidMissing $_.Path).Count -eq 0 })) {
        Add-Result 'HUMAN' 'unity-android' 'no editor has complete "Android Build Support" (OpenJDK and Android SDK & NDK Tools). In Unity Hub > Installs > (version) > Add modules, check Android Build Support with both sub-modules.'
    }
}

# --- Bundled sample (AGENTS.md step 3): needs its exact editor version plus the modules for -Target
if (-not $NoSample) {
    $pvText = Get-Content -LiteralPath (Join-Path $SampleRoot 'ProjectSettings\ProjectVersion.txt')
    $sv = (($pvText | Select-String '^m_EditorVersion:') -split ':\s*')[1].Trim()
    $rev = if (($pvText -join "`n") -match 'm_EditorVersionWithRevision:\s*\S+\s*\((\w+)\)') { $Matches[1] } else { '' }
    $hubHint = if ($rev) { " (Unity Hub > Installs > Install Editor > Archive, or open unityhub://$sv/$rev)" } else { '' }
    $si = @($installs | Where-Object Version -eq $sv) | Select-Object -First 1
    if (-not $si) {
        Add-Result 'HUMAN' 'sample-unity' "the sample check needs exactly Unity $sv$hubHint with the $targetText module(s); other versions, even newer patches, are not used. Install it, or skip the sample check: rerun with -NoSample.$onlyOneHint"
    } else {
        $gaps = @(Get-ModuleGaps $si.Path $si.Version)
        if ($gaps) { Add-Result 'HUMAN' 'sample-unity' "Unity $sv lacks $($gaps -join '; ') for the sample. Add it in Unity Hub, or rerun with -NoSample.$onlyOneHint" }
        else { Add-Result 'OK' 'sample-unity' "Unity $sv with the $targetText module(s) for sample\EmuSmoke" }
    }
}

# --- The person's project
if ($ProjectPath) {
    try {
        # "C:\My Game\" would break native calls such as git -C (\" reads as an escaped quote).
        Assert-PathArg 'ProjectPath' $ProjectPath
        $ProjectPath = Remove-TrailingSeparator (Resolve-Path -LiteralPath $ProjectPath -ErrorAction Stop).ProviderPath

        # The lab must sit outside the project: inside it, the lab's files show up as the person's changes and the
        # "outside the project" build output (artifacts\builds) lands in the project.
        if (Test-PathInside $RepoRoot $ProjectPath) {
            Add-Result 'FAIL' 'lab-location' "this lab ($RepoRoot) is inside the project folder ($ProjectPath). Clone the lab next to the project instead, outside its folder and git work tree (e.g. git clone <lab url> %USERPROFILE%\unity-emu-lab), and run every command from that clone. Ask the person before deleting this copy."
        } elseif ((Test-PathInside $ProjectPath $RepoRoot) -and -not (Test-SamePath $ProjectPath $SampleRoot)) {
            Add-Result 'FAIL' 'lab-location' "the project ($ProjectPath) is inside this lab ($RepoRoot). Use the project where it normally lives, outside the lab clone; keep the lab next to it (e.g. %USERPROFILE%\unity-emu-lab)."
        } elseif (-not (Test-SamePath $ProjectPath $SampleRoot) -and (Get-Command git -ErrorAction SilentlyContinue)) {
            # Outside the project folder but inside its git work tree (e.g. <repo>\Client is the project and the lab sits
            # at <repo>\unity-emu-lab): the lab then shows up as untracked in the person's repository.
            $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
            $projTop = ((& git -C $ProjectPath rev-parse --show-toplevel 2>$null) -join '').Trim()
            $ErrorActionPreference = $eap
            if ($LASTEXITCODE -eq 0 -and $projTop) {
                $projTop = $projTop.Replace('/', '\')
                if (Test-PathInside $RepoRoot $projTop) {
                    Add-Result 'FAIL' 'lab-location' "this lab ($RepoRoot) is inside the project's git work tree ($projTop), so it shows up as the person's untracked files. Clone the lab outside that repository (e.g. %USERPROFILE%\unity-emu-lab) and run every command from that clone. Ask the person before deleting this copy."
                }
            }
        }

        $u = Get-UnityEditorForProject $ProjectPath
        Add-Result 'OK' 'project-unity' "$ProjectPath needs Unity $($u.Version): installed"
        $projectBackend = Get-ProjectStandaloneBackend $ProjectPath
        $gaps = @(Get-ModuleGaps $u.Path $u.Version $projectBackend)
        if ($gaps) { Add-Result 'HUMAN' 'project-modules' "Unity $($u.Version) lacks $($gaps -join '; '). Add it in Unity Hub > Installs > $($u.Version) > Add modules.$onlyOneHint" }

        if (Test-ProjectLocked $ProjectPath) {
            $holders = @(Get-UnityProcessesForProject $ProjectPath)
            $editorIds = @($holders | Where-Object { -not $_.Batchmode } | ForEach-Object ProcessId)
            $batch = @($holders | Where-Object { $_.Batchmode -and -not $_.Worker })
            # Only import workers visible (an Editor opened without -projectPath): their parent is the Editor, not a build.
            if (-not $editorIds.Count -and -not $batch.Count) {
                $editorIds = @($holders | Where-Object { $_.Worker -and $_.ParentProcessId } | ForEach-Object ParentProcessId | Select-Object -Unique)
            }
            if ($editorIds.Count) {
                Add-Result 'WARN' 'project-open' "the project is open in a Unity Editor (pid $($editorIds -join ', ')): batchmode builds are blocked. Close it, or build from that Editor and pass the output with -SkipBuild."
            } elseif ($batch) {
                Add-Result 'WARN' 'project-open' "a batchmode Unity (pid $(($batch | ForEach-Object ProcessId) -join ', ')) holds the project: a build is still running, or an interrupted run left it behind. Batchmode builds are blocked until it exits. Wait for it; if no build should be running, ask the person before stopping it."
            } else {
                Add-Result 'WARN' 'project-open' 'Temp\UnityLockfile is held, but no Unity.exe that this shell can see names the project (an elevated Unity or another Windows user?): batchmode builds are blocked until it closes. Ask the person to close it.'
            }
        }

        # Baseline before any build: the build may change tracked files (AGENTS.md rule 5).
        $inGit = $false; $gitRefused = $false; $gitMissingAt = $null
        $hasGit = [bool](Get-Command git -ErrorAction SilentlyContinue)
        if ($hasGit) {
            # $ErrorActionPreference is Continue here, so stderr comes back as text lines.
            $gitLines = @(& git -C $ProjectPath rev-parse --is-inside-work-tree 2>&1 | ForEach-Object { "$_".Trim() })
            $inGit = $gitLines -contains 'true'
            # An agent sandbox that runs as another Windows user (e.g. Codex) makes git refuse the person's repo.
            $gitRefused = ($gitLines -join ' ') -match 'dubious ownership|is owned by someone else'
        } else {
            # GUI clients (SourceTree, Fork, GitHub Desktop) bundle their own git and often leave git.exe off PATH.
            $d = $ProjectPath
            while ($d -and -not $gitMissingAt) {
                $g = [IO.Path]::Combine($d, '.git')
                if ([IO.Directory]::Exists($g) -or [IO.File]::Exists($g)) { $gitMissingAt = $d } else { $d = [IO.Path]::GetDirectoryName($d) }
            }
        }
        $noGitNote = if ($hasGit) { '' } else { ' (git.exe is not on PATH either)' }
        if ($gitMissingAt) {
            Add-Result 'HUMAN' 'project-vcs' "the project is in a git repo ($gitMissingAt\.git), but git.exe is not on PATH. Ask the person to install Git for Windows, or add the git that came with their git client to PATH, then open a new shell and rerun doctor. Do not treat the project as non-git."
        } elseif ($gitRefused) {
            Add-Result 'WARN' 'project-vcs' 'git refused the project (dubious ownership): this shell runs as another Windows user, usually an agent sandbox. Rerun doctor and every project command outside the sandbox (AGENTS.md rule 11); do not treat the project as non-git.'
        } elseif ($inGit) {
            $dirty = @(& git -C $ProjectPath status --porcelain -- . 2>$null)
            if ($dirty.Count) { Add-Result 'WARN' 'project-vcs' "git: $($dirty.Count) uncommitted path(s) before any build. Never revert them: use scripts\project-guard.ps1 Snapshot/Report/Revert, which reverts only what the build changed, with consent (AGENTS.md rule 5)." }
            else { Add-Result 'OK' 'project-vcs' 'git: clean working tree' }
        } elseif (Test-Path -LiteralPath (Join-Path $ProjectPath '.plastic')) {
            Add-Result 'WARN' 'project-vcs' 'Unity Version Control (Plastic SCM) workspace: no git baseline. Ask before building; with consent copy ProjectSettings and Packages to a backup folder first.'
        } else {
            Add-Result 'WARN' 'project-vcs' "not a git work tree (Perforce or none)$($noGitNote): no baseline. Ask before building; with consent copy ProjectSettings and Packages to a backup folder first."
        }
        Add-Result 'INFO' 'project-platform' "a batchmode build for $($targetText -replace ' and ', '/') switches the project's active platform (stored in Library, not in git). The Editor then reopens on it; switching back may reimport."

        if ($wantWindows) {
            Add-Result 'INFO' 'project-windows' "Windows scripting backend: $projectBackend$(if ($projectBackend -eq 'IL2CPP') { ' (needs the IL2CPP module and Visual Studio C++, checked below)' })."
            if ($projectBackend -eq 'IL2CPP') { $script:windowsIl2cpp = $true }
        }
        if ($wantAndroid) {
            $ps = Join-Path $ProjectPath 'ProjectSettings\ProjectSettings.asset'
            if (Test-Path -LiteralPath $ps) {
                $txt = [IO.File]::ReadAllText($ps)
                $backend = [regex]::Match($txt, 'scriptingBackend:\s*\r?\n(?:\s+\w+:\s*\d+\r?\n)*?\s+Android:\s*(\d+)')
                $arch = [regex]::Match($txt, 'AndroidTargetArchitectures:\s*(\d+)')
                $mono = -not $backend.Success -or $backend.Groups[1].Value -eq '0'
                $noArm64 = $arch.Success -and (([int]$arch.Groups[1].Value -band 2) -eq 0)
                if ($mono -or $noArm64) {
                    Add-Result 'TODO' 'project-abi' "Player Settings build $(if ($mono) { 'Mono (ARMv7 only)' } else { 'without ARM64' }): the x86_64 emulator runs only arm64-v8a/x86_64 code. With consent, build IL2CPP + ARM64 for the test inside the build method, and restore settings afterwards (AGENTS.md)."
                }
            }
        }
    } catch {
        Add-Result 'FAIL' 'project-unity' $_.Exception.Message
    }
}

# --- Windows player: it runs on this desktop, windowed
if ($wantWindows) {
    $sid = [Diagnostics.Process]::GetCurrentProcess().SessionId
    if ($sid -eq 0) {
        Add-Result 'FAIL' 'windows-desktop' 'this shell runs in session 0 (a service or a scheduled task without a desktop): the Windows smoke test cannot open a player window. Run it from a signed-in desktop session.'
    } else {
        Add-Result 'INFO' 'windows-desktop' "the Windows smoke test opens the player window on this desktop (session $sid). It does not click unless -Tap is given (then it takes the focus and moves the mouse for a moment). Sound: the build must be muted (EmuProjectBuild.BuildWindows turns on Disable Unity Audio for the test build and says so in its build log); otherwise the run stops unless the person allows sound (-AllowAudio)."
    }
    if ($script:windowsIl2cpp) {
        # IL2CPP turns C# into C++ and compiles it with MSVC: Visual Studio (or its Build Tools) with the C++ workload.
        $vswhere = [IO.Path]::Combine(${env:ProgramFiles(x86)}, 'Microsoft Visual Studio\Installer\vswhere.exe')
        $vc = $null
        if (Test-Path -LiteralPath $vswhere) {
            $vc = @(& $vswhere -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2>$null) | Select-Object -First 1
        }
        if ($vc) { Add-Result 'OK' 'windows-il2cpp-cpp' "Visual Studio C++ tools: $vc" }
        else { Add-Result 'HUMAN' 'windows-il2cpp-cpp' 'the project builds Windows with IL2CPP, which needs Visual Studio 2019 or newer (or its Build Tools) with "Desktop development with C++" (MSVC and a Windows SDK). Ask the person to install it with the Visual Studio Installer.' }
    }
}

# --- Android SDK, emulator, AVD
$sdkMissing = $false
if ($androidHost) {
    Add-Result 'INFO' 'android-paths' "SDK root $SdkRoot (from $SdkRootSource); AVD home $AvdHome (from $AvdHomeSource). Order: environment variable (ANDROID_SDK_ROOT / ANDROID_AVD_HOME; ANDROID_HOME is ignored), then local.settings.json, then the default."
    $adbNote = if ($AdbSource -like 'SDK root*') { ' EMU_ADB or local.settings.json "adb" picks another adb.exe: use the one bundled with the Unity editor that builds Android here, or the two adb versions stop each other''s server (and a running logcat capture).' } else { '' }
    Add-Result 'INFO' 'adb' "$Adb (from $AdbSource).$adbNote"
    try {
        $lease = Read-EmuLease 'unity-test'
        if ($lease) {
            $st = if (Test-EmuLeaseValid $lease) { "leased by $($lease.owner) until $($lease.expiresAt)" } else { "lease of $($lease.owner) ran out at $($lease.expiresAt); the next start-emulator.ps1 takes it over" }
            Add-Result 'INFO' 'emulator-lease' "AVD unity-test $st ($(Get-EmuLeasePath 'unity-test'))"
        }
    } catch { Add-Result 'WARN' 'emulator-lease' $_.Exception.Message }
    $sdkParts = [ordered]@{
        'platform-tools' = $SdkAdb
        'emulator' = $EmulatorExe
        'system image android-35 google_apis x86_64' = [IO.Path]::Combine($SdkRoot, 'system-images\android-35\google_apis\x86_64\system.img')
        'AVD unity-test' = [IO.Path]::Combine($AvdHome, 'unity-test.avd\config.ini')
    }
    $missing = @($sdkParts.Keys | Where-Object { -not (Test-Path -LiteralPath $sdkParts[$_]) })
    $sdkMissing = @($missing | Where-Object { $_ -ne 'AVD unity-test' }).Count -gt 0
    if ($missing) {
        $avdNote = if ($missing -contains 'AVD unity-test') { " plus up to about 10 GB for the AVD at $AvdHome" } else { '' }
        Add-Result 'TODO' 'android-sdk' "missing under $SdkRoot / $AvdHome : $($missing -join ', '). Run scripts\setup-android-sdk.ps1 -AcceptLicenses only after the person agrees to the Android SDK license (downloads about 1.5 GB, about 4.5 GB on disk at $SdkRoot$avdNote). $moveHint."
        # avdmanager (cmdline-tools latest) needs the OpenJDK 17 that Unity 6 bundles; 2022.3 and earlier bundle JDK 11.
        $jdkOf = { param($e) Get-JdkMajor (Join-Path $e.Path 'Editor\Data\PlaybackEngines\AndroidPlayer\OpenJDK') }
        $jdk17 = @($installs | Where-Object { (Get-UnityAndroidMissing $_.Path -BundledOnly).Count -eq 0 -and (& $jdkOf $_) -ge 17 })
        if ($installs -and -not $jdk17) {
            # setup-android-sdk.ps1 then falls back to a JDK 17+ from Unity's External Tools or JAVA_HOME, and bootstraps
            # with any editor's bundled cmdline-tools or the External Tools SDK's.
            $altJdk = Find-JdkFallback 17
            $boot = if (Test-Path -LiteralPath $SdkManager) { $SdkManager } else { Find-BootstrapSdkManager }
            if ($altJdk -and $boot) {
                Add-Result 'WARN' 'android-sdk-jdk' "no Unity editor bundles OpenJDK 17+ with complete Android Build Support; setup-android-sdk.ps1 will use $($altJdk.Source) $($altJdk.Home) (JDK $($altJdk.Major)) and $boot."
            } elseif ($altJdk) {
                Add-Result 'HUMAN' 'android-sdk-jdk' "setup-android-sdk.ps1 has a JDK ($($altJdk.Source), JDK $($altJdk.Major)) but no sdkmanager to start from: add 'Android SDK & NDK Tools' of Android Build Support to an editor in Unity Hub > Installs > (version) > Add modules."
            } else {
                # Unity 6 (6000+) bundles JDK 17; 2023.x and earlier bundle JDK 11. An editor with JDK 17 already, or a
                # Unity 6 lacking only OpenJDK / Android sub-modules, needs modules added, not a new editor.
                $partial = @($installs | Where-Object {
                    $m = @(Get-UnityAndroidMissing $_.Path -BundledOnly)
                    $m.Count -gt 0 -and (($m -notcontains 'OpenJDK' -and (& $jdkOf $_) -ge 17) -or
                                         ($m -contains 'OpenJDK' -and (Get-UnityMajor $_.Version) -ge 6000)) })
                if ($partial) {
                    $names = ($partial | ForEach-Object { "Unity $($_.Version) (missing $((Get-UnityAndroidMissing $_.Path -BundledOnly) -join ', '))" }) -join '; '
                    Add-Result 'HUMAN' 'android-sdk-jdk' "setup-android-sdk.ps1 needs an editor with OpenJDK 17+ and complete Android Build Support. Already installed: $names. Add the missing parts of Android Build Support (OpenJDK, Android SDK & NDK Tools) to one of them in Unity Hub > Installs > (version) > Add modules; no new editor is needed."
                } else {
                    Add-Result 'HUMAN' 'android-sdk-jdk' 'setup-android-sdk.ps1 needs an editor whose Android Build Support bundles OpenJDK 17+ (Unity 6), or JAVA_HOME pointing at a JDK 17+. Unity 2023.x and earlier bundle JDK 11, which avdmanager refuses. Install Unity 6 (e.g. the sample version) with Android Build Support; the project can keep its own editor.'
                }
            }
        }
    } else {
        Add-Result 'OK' 'android-sdk' "$SdkRoot (platform-tools, emulator, android-35 image), AVD unity-test in $AvdHome"
    }
    foreach ($loc in @([pscustomobject]@{ Name = 'SDK'; Path = $SdkRoot }, [pscustomobject]@{ Name = 'AVD home'; Path = $AvdHome })) {
        if ((Test-PathInside $loc.Path $env:LOCALAPPDATA) -or (Test-PathInside $loc.Path $env:APPDATA)) {
            Add-Result 'WARN' 'android-sdk-path' "the $($loc.Name) is under AppData ($($loc.Path)); inside a packaged AI app that location is redirected. Prefer the defaults (%USERPROFILE%\Android\Sdk, %USERPROFILE%\.android\avd)."
        }
    }
    if ("$SdkRoot$AvdHome" -match '[^\x20-\x7E]') {
        Add-Result 'WARN' 'android-path-chars' "the SDK root or AVD home has non-ASCII characters ($SdkRoot, $AvdHome); some Android tools fail on such paths. If setup or the emulator fails, ask the person for an ASCII folder: $moveHint."
    }
    $defaultSdk = Join-Path $env:USERPROFILE 'Android\Sdk'
    if (-not (Test-SamePath $SdkRoot $defaultSdk)) {
        Add-Result 'WARN' 'mobile-mcp-sdk' "the SDK is at $SdkRoot (from $SdkRootSource), but .mcp.json, .cursor\mcp.json and the Codex snippet in AGENTS.md use $defaultSdk. If you use mobile-mcp, change ANDROID_HOME there to $SdkRoot (local edit, do not commit)."
    }
}

# --- Disk space, per drive: what still has to be written where.
$needs = @()
if ($androidHost) {
    if ($sdkMissing) { $needs += [pscustomobject]@{ Path = $SdkRoot; Gb = 5; What = 'Android SDK' } }
    if (-not (Test-Path -LiteralPath ([IO.Path]::Combine($AvdHome, 'unity-test.avd\config.ini')))) { $needs += [pscustomobject]@{ Path = $AvdHome; Gb = 10; What = 'AVD unity-test (8 GB data + snapshots)' } }
    else { $needs += [pscustomobject]@{ Path = $AvdHome; Gb = 2; What = 'AVD growth' } }
}
$needs += [pscustomobject]@{ Path = $RepoRoot; Gb = 4; What = 'sample builds, test results, browser profiles' }
if ($ProjectPath) { $needs += [pscustomobject]@{ Path = $ProjectPath; Gb = 3; What = 'project Library/Temp during builds' } }
foreach ($g in ($needs | Group-Object { try { [IO.Path]::GetPathRoot([IO.Path]::GetFullPath($_.Path)) } catch { '?' } })) {
    $root = $g.Name
    $sum = ($g.Group | Measure-Object Gb -Sum).Sum
    $what = ($g.Group | ForEach-Object What) -join ', '
    $drv = if ($root -match '^([A-Za-z]):\\?$') { Get-PSDrive $Matches[1] -ErrorAction SilentlyContinue } else { $null }
    $hint = if ($what -match 'Android SDK|AVD') { " $moveHint." } else { '' }
    if (-not $drv) {
        Add-Result 'WARN' 'disk' "cannot measure free space on '$root' (network path or missing drive); about $sum GB is needed there: $what"
    } else {
        $free = [math]::Round($drv.Free / 1GB)
        if ($free -ge $sum) { Add-Result 'OK' 'disk' "$free GB free on $root (about $sum GB still needed: $what)" }
        else { Add-Result 'FAIL' 'disk' "$free GB free on $root (about $sum GB still needed: $what).$hint" }
    }
}

# --- Browser for WebGL
if ($wantWebGL) {
    . "$PSScriptRoot\cdp.ps1"
    $browser = Find-Browser
    if ($browser) { Add-Result 'OK' 'browser' $browser } else { Add-Result 'FAIL' 'browser' 'Chrome or Edge is needed for WebGL tests.' }
}

# --- Optional: Node.js for mobile-mcp (agent screenshots/taps on the emulator)
$node = Get-Command node -ErrorAction SilentlyContinue
if ($node) {
    $v = (& node --version) -replace '^v', ''
    $major = [int]($v -split '\.')[0]
    Add-Result $(if ($major -ge 20) { 'OK' } else { 'WARN' }) 'node' "v$v (only for mobile-mcp; 20+ needed)"
} else {
    Add-Result 'INFO' 'node' 'not found; only needed for mobile-mcp (agent screenshots and taps). The scripts work without it.'
}

$blocking = @($results | Where-Object { $_.Status -in 'HUMAN', 'FAIL' })
$todo = @($results | Where-Object Status -eq 'TODO')
Write-Host ''
Write-Host ("DOCTOR {0} human/fail={1} todo={2}" -f $(if ($blocking) { 'BLOCKED' } elseif ($todo) { 'TODO' } else { 'READY' }), $blocking.Count, $todo.Count)
exit $(if ($blocking) { 1 } elseif ($todo) { 2 } else { 0 })
