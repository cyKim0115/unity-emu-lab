# Shared paths and helpers. Dot-source from other scripts: . "$PSScriptRoot\common.ps1"
# ASCII only (Windows PowerShell 5.1 reads BOM-less .ps1 as CP949).

$ErrorActionPreference = 'Stop'

$script:RepoRoot   = Split-Path -Parent $PSScriptRoot
$script:SampleRoot = [IO.Path]::Combine($RepoRoot, 'sample\EmuSmoke')
# Lab-only settings (setup-android-sdk.ps1 -SdkRoot / -AvdHome). Not committed (.gitignore).
$script:LocalSettingsPath = [IO.Path]::Combine($RepoRoot, 'local.settings.json')
$script:DefaultAvd = if ($env:EMU_AVD) { $env:EMU_AVD } else { 'unity-test' }
# JAVA_HOME as this process got it, before Use-UnityJdk replaces it (a fallback JDK for setup-android-sdk.ps1).
$script:OrigJavaHome = $env:JAVA_HOME
# Success lines of emulator -accel-check (37.x): "WHPX(10.0.19045) ...", "WHPX (10.0.19045) ...", "AEHD (version 2.2) ...".
$script:AccelOkPattern = '\b(WHPX|AEHD) ?\([^)]*\) is installed and usable'
$script:UnityPrefsKey = 'HKCU:\Software\Unity Technologies\Unity Editor 5.x'
$script:ExternalToolsCache = $null

function Remove-TrailingSeparator([string]$Path) {
    # "C:\Work\My Game\" breaks native argument passing (\" reads as an escaped quote). A bare root (C:\) stays.
    if (-not $Path) { return $Path }
    if ($Path.Length -gt [IO.Path]::GetPathRoot($Path).Length) { return $Path.TrimEnd('\', '/') }
    return $Path
}

function Assert-PathArg([string]$Name, [string]$Value) {
    # With "powershell -File", a path written as "C:\My Game\" ends in \" which Windows reads as a literal quote:
    # the quote and every argument after it end up inside this value.
    if ($Value -match '"') {
        throw "-$Name contains a quote ($Value): with powershell -File a path ending in \ before its closing quote swallows the arguments after it. Rerun without the trailing backslash, e.g. -$Name 'C:\Work\My Game'."
    }
}

# A path ending in "\" would be quoted as "...\" and Windows reads \" as a literal quote, so the program would get
# one argument holding the rest of the line. Trailing backslashes are doubled when quoting (for Start-Process lines).
function Format-QuotedArg([string]$Value) { '"' + ($Value -replace '(\\+)$', '$1$1') + '"' }

function ConvertTo-FullPath([string]$Path) {
    # Absolute path, relative to the PowerShell location ($PWD). Literal: [brackets] are not wildcards here.
    if (-not $Path) { return $Path }
    try { return $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Path) }
    catch { try { return [IO.Path]::GetFullPath($Path) } catch { return $Path } }   # e.g. a missing drive
}

function Get-NormalizedPath([string]$Path) {
    # Comparison form: full path, backslashes, no trailing separator. Compare it case-insensitively.
    if (-not $Path) { return '' }
    $p = (ConvertTo-FullPath $Path) -replace '/', '\'
    try { $p = [IO.Path]::GetFullPath($p) } catch { }
    return $p.TrimEnd('\')
}

function Test-SamePath([string]$A, [string]$B) {
    if (-not $A -or -not $B) { return $false }
    return [string]::Equals((Get-NormalizedPath $A), (Get-NormalizedPath $B), [StringComparison]::OrdinalIgnoreCase)
}

function Get-CleanEnvPath([string]$Value) {
    # A folder from an environment variable or settings file: no surrounding quotes (setx "C:\Sdk\" leaves one)
    # and no trailing separator (--sdk_root="C:\Sdk\" would read \" as a literal quote).
    if (-not $Value) { return $null }
    $v = $Value.Trim().Trim('"').Trim()
    if (-not $v) { return $null }
    try { return Remove-TrailingSeparator $v } catch { return $v.TrimEnd('\', '/') }
}

function Read-LocalSettings {
    # local.settings.json as an object, or $null. A file that cannot be read is ignored and LocalSettingsError says why.
    $script:LocalSettingsError = $null
    if (-not [IO.File]::Exists($LocalSettingsPath)) { return $null }
    try { return ([IO.File]::ReadAllText($LocalSettingsPath, [Text.Encoding]::UTF8) | ConvertFrom-Json) }
    catch { $script:LocalSettingsError = "$LocalSettingsPath is not valid JSON ($($_.Exception.Message))"; return $null }
}

function Save-LocalSettings([hashtable]$Values) {
    # Merge $Values into local.settings.json (a $null value removes the key). UTF-8 without BOM.
    $cur = [ordered]@{}
    $old = Read-LocalSettings
    if ($LocalSettingsError) { throw "Not overwriting it: $LocalSettingsError. Fix or delete the file first." }
    if ($old) { foreach ($p in $old.PSObject.Properties) { $cur[$p.Name] = $p.Value } }
    foreach ($k in $Values.Keys) { if ($null -eq $Values[$k]) { $cur.Remove($k) } else { $cur[$k] = "$($Values[$k])" } }
    $json = ([pscustomobject]$cur | ConvertTo-Json)
    [IO.File]::WriteAllText($LocalSettingsPath, $json + "`r`n", (New-Object Text.UTF8Encoding $false))
}

function Resolve-AndroidLocations {
    # Android SDK root: ANDROID_SDK_ROOT, then local.settings.json "sdkRoot", then %USERPROFILE%\Android\Sdk.
    # AVD home: ANDROID_AVD_HOME, then local.settings.json "avdHome", then %USERPROFILE%\.android\avd.
    # The default is %USERPROFILE%\Android\Sdk, not %LOCALAPPDATA%: AI agents that run inside packaged (MSIX) apps,
    # such as the Claude desktop app, have AppData writes redirected into the app's private folder, so an SDK
    # installed under AppData by the agent is invisible to normal terminals.
    # Sets SdkRoot/AvdHome, *Source ('env ANDROID_SDK_ROOT', 'local.settings.json', 'default', ...) and the tool paths.
    $ls = Read-LocalSettings
    $sdk = $null; $src = $null
    $v = Get-CleanEnvPath $env:ANDROID_SDK_ROOT
    if ($v) { $sdk = $v; $src = 'env ANDROID_SDK_ROOT' }
    if (-not $sdk -and $ls -and $ls.sdkRoot) { $sdk = Get-CleanEnvPath "$($ls.sdkRoot)"; $src = 'local.settings.json' }
    if (-not $sdk) { $sdk = [IO.Path]::Combine($env:USERPROFILE, 'Android\Sdk'); $src = 'default' }
    $avd = Get-CleanEnvPath $env:ANDROID_AVD_HOME; $asrc = 'env ANDROID_AVD_HOME'
    if (-not $avd -and $ls -and $ls.avdHome) { $avd = Get-CleanEnvPath "$($ls.avdHome)"; $asrc = 'local.settings.json' }
    if (-not $avd) { $avd = [IO.Path]::Combine($env:USERPROFILE, '.android\avd'); $asrc = 'default' }
    $script:SdkRoot = $sdk; $script:SdkRootSource = $src
    $script:AvdHome = $avd; $script:AvdHomeSource = $asrc
    # [IO.Path]::Combine, not Join-Path: Join-Path throws while loading if the SDK root names a missing drive.
    try {
        $script:Adb         = [IO.Path]::Combine($sdk, 'platform-tools\adb.exe')
        $script:EmulatorExe = [IO.Path]::Combine($sdk, 'emulator\emulator.exe')
        $script:SdkManager  = [IO.Path]::Combine($sdk, 'cmdline-tools\latest\bin\sdkmanager.bat')
        $script:AvdManager  = [IO.Path]::Combine($sdk, 'cmdline-tools\latest\bin\avdmanager.bat')
    } catch { throw "Android SDK root '$sdk' (from $src) is not a valid path: $($_.Exception.Message)" }
    # adb: EMU_ADB, then local.settings.json "adb", then the SDK's. Point it at the adb bundled with the Unity editor
    # that builds Android on this PC: two adb versions stop each other's server ("daemon not running; starting now"),
    # which also ends a running logcat capture. The emulator works with any adb version.
    $script:SdkAdb = $script:Adb
    $script:AdbSource = "SDK root, $src"
    $a = Get-CleanEnvPath $env:EMU_ADB
    if ($a) { $script:Adb = $a; $script:AdbSource = 'env EMU_ADB' }
    elseif ($ls -and $ls.adb) { $script:Adb = Get-CleanEnvPath "$($ls.adb)"; $script:AdbSource = 'local.settings.json adb' }
}
Resolve-AndroidLocations

function Set-AndroidEnv {
    # Point the Android tools this process starts (sdkmanager, avdmanager, emulator, adb) at the lab's SDK and AVD home.
    # An ANDROID_AVD_HOME that is already set keeps its folder; it is only cleaned (quotes, trailing separators).
    $env:ANDROID_SDK_ROOT = $SdkRoot
    $env:ANDROID_HOME = $SdkRoot
    $env:ANDROID_AVD_HOME = $AvdHome
}

function Set-LabAndroidLocations([string]$SdkRootArg, [string]$AvdHomeArg) {
    # setup-android-sdk.ps1 -SdkRoot / -AvdHome: save the chosen folders in local.settings.json so every later command
    # of this lab uses them without a global environment change. An environment variable still wins over the file,
    # so a different value in ANDROID_SDK_ROOT / ANDROID_AVD_HOME is refused instead of being ignored.
    $save = @{}
    $items = @(
        [pscustomobject]@{ Name = 'SdkRoot'; Arg = $SdkRootArg; Key = 'sdkRoot'; Source = $SdkRootSource; Current = $SdkRoot },
        [pscustomobject]@{ Name = 'AvdHome'; Arg = $AvdHomeArg; Key = 'avdHome'; Source = $AvdHomeSource; Current = $AvdHome })
    foreach ($it in $items) {
        if (-not $it.Arg) { continue }
        Assert-PathArg $it.Name $it.Arg
        $full = Get-CleanEnvPath (ConvertTo-FullPath $it.Arg)
        if ($full -match '[%"]') { throw "-$($it.Name) '$full' contains % or a double quote; pick a folder without them." }
        if ($it.Source -like 'env *' -and -not (Test-SamePath $full $it.Current)) {
            throw "-$($it.Name) $full conflicts with $($it.Source -replace '^env ', '')=$($it.Current), which wins over local.settings.json for every later command. Either drop -$($it.Name) to use $($it.Current), or have the person change or remove that environment variable (AGENTS.md rule 12) and open a new shell."
        }
        $save[$it.Key] = $full
    }
    if (-not $save.Count) { return }
    Save-LocalSettings $save
    Write-Host "LOCAL_SETTINGS $LocalSettingsPath $(($save.Keys | Sort-Object | ForEach-Object { "$_=$($save[$_])" }) -join ' ')"
    Resolve-AndroidLocations
}

function Get-UnityVersionKey([string]$Version) {
    # Sortable [version] from "6000.6.0f1" or a folder name like "Unity 6000.6.0f1"; 0.0 when none.
    if ($Version -match '(\d+)\.(\d+)(?:\.(\d+)(?:([abfpx])(\d+))?)?') {
        $patch = if ($Matches[3]) { $Matches[3] } else { '0' }
        # Release stage then number: 6000.6.0b3 < 6000.6.0f1 < 6000.6.0f2 < 6000.6.0p1
        $rev = 0
        if ($Matches[4]) { $rev = ('abfpx'.IndexOf($Matches[4]) * 10000) + [int]$Matches[5] }
        return [version]"$($Matches[1]).$($Matches[2]).$patch.$rev"
    }
    return [version]'0.0'
}

function Get-UnityMajor([string]$Version) {
    # 6000 for "6000.6.0f1", 2022 for "2022.3.62f1"; 0 when the name has no version.
    return (Get-UnityVersionKey $Version).Major
}

function Find-PathPattern([string]$Base, [string]$Relative) {
    # Existing paths matching "<Base>\<Relative>", where segments of Relative may hold * or ?. Base is taken
    # literally, so [brackets] in it are not wildcards (Test-Path -Path would treat them as one).
    $cur = @($Base)
    $segs = @($Relative -split '[\\/]' | Where-Object { $_ })
    for ($i = 0; $i -lt $segs.Count; $i++) {
        $seg = $segs[$i]; $last = ($i -eq $segs.Count - 1)
        $next = @()
        foreach ($d in $cur) {
            if (-not [IO.Directory]::Exists($d)) { continue }
            if ($seg -match '[*?]') {
                try {
                    if ($last) { $next += @([IO.Directory]::GetFileSystemEntries($d, $seg)) }
                    else { $next += @([IO.Directory]::GetDirectories($d, $seg)) }
                } catch { }
            } else {
                $p = [IO.Path]::Combine($d, $seg)
                if ([IO.Directory]::Exists($p) -or ($last -and [IO.File]::Exists($p))) { $next += $p }
            }
        }
        $cur = $next
        if (-not $cur.Count) { return }
    }
    return $cur
}

function Get-UnityInstalls([switch]$IncludeShadowed) {
    # Installed editors as @{ Version; Path; Source; Shadowed } (Path = folder that holds Editor\Unity.exe), in this
    # priority order: $env:UNITY_EDITOR_ROOT, Unity Hub's install location (Preferences > Installs), the default
    # location, then editors added to Unity Hub with "Locate". When one version is installed twice the first one
    # wins and the later copy is left out; -IncludeShadowed returns it too, with Shadowed = $true.
    $roots = @()
    if ($env:UNITY_EDITOR_ROOT) { $roots += [pscustomobject]@{ Dir = (Get-CleanEnvPath $env:UNITY_EDITOR_ROOT); Source = 'UNITY_EDITOR_ROOT' } }
    # Unity Hub writes its JSON as UTF-8 without BOM; PS 5.1 Get-Content would read it as CP949 and garble non-ASCII paths.
    $hubCfg = [IO.Path]::Combine($env:APPDATA, 'UnityHub\secondaryInstallPath.json')
    if ([IO.File]::Exists($hubCfg)) {
        try { $p = [IO.File]::ReadAllText($hubCfg, [Text.Encoding]::UTF8) | ConvertFrom-Json; if ($p) { $roots += [pscustomobject]@{ Dir = "$p"; Source = 'Unity Hub install location' } } } catch { }
    }
    $roots += [pscustomobject]@{ Dir = [IO.Path]::Combine($env:ProgramFiles, 'Unity\Hub\Editor'); Source = 'default location' }
    # Version comes from the folder name ("6000.6.0f1", also "Unity 6000.6.0f1"), else from Unity.exe itself.
    $versionOf = {
        param($dir)
        if ($dir.Name -match '(\d+\.\d+\.\d+[abfpx]\d+)') { return $Matches[1] }
        $pv = (Get-Item -LiteralPath ([IO.Path]::Combine($dir.FullName, 'Editor\Unity.exe'))).VersionInfo.ProductVersion
        if ($pv -match '(\d+\.\d+\.\d+[abfpx]\d+)') { return $Matches[1] }
        return $dir.Name
    }
    $list = @()
    foreach ($r in $roots) {
        if (-not $r.Dir -or -not [IO.Directory]::Exists($r.Dir)) { continue }
        $dirs = @(Get-ChildItem -LiteralPath $r.Dir -Directory -ErrorAction SilentlyContinue)
        # UNITY_EDITOR_ROOT may also name one version folder itself.
        if ([IO.File]::Exists([IO.Path]::Combine($r.Dir, 'Editor\Unity.exe'))) { $dirs = @(Get-Item -LiteralPath $r.Dir) + $dirs }
        $dirs | Where-Object { [IO.File]::Exists([IO.Path]::Combine($_.FullName, 'Editor\Unity.exe')) } |
            ForEach-Object { $list += [pscustomobject]@{ Version = (& $versionOf $_); Path = $_.FullName; Source = $r.Source } }
    }
    $located = [IO.Path]::Combine($env:APPDATA, 'UnityHub\editors-v2.json')
    if ([IO.File]::Exists($located)) {
        try {
            foreach ($d in ([IO.File]::ReadAllText($located, [Text.Encoding]::UTF8) | ConvertFrom-Json).data) {
                $exe = "$(@($d.location)[0])"
                if ($d.version -and $exe -and [IO.File]::Exists($exe)) {
                    $list += [pscustomobject]@{ Version = "$($d.version)"; Path = [IO.Path]::GetDirectoryName([IO.Path]::GetDirectoryName($exe)); Source = 'Unity Hub Locate' }
                }
            }
        } catch { }
    }
    # Keep the discovery order (it is the priority). Do not sort: same-version copies would be picked by path order.
    $seenPath = @{}; $firstOf = @{}; $out = @()
    foreach ($i in $list) {
        $k = (Get-NormalizedPath $i.Path).ToLowerInvariant()
        if ($seenPath.ContainsKey($k)) { continue }
        $seenPath[$k] = $true
        $shadowed = $firstOf.ContainsKey($i.Version)
        if (-not $shadowed) { $firstOf[$i.Version] = $i.Path }
        elseif (-not $IncludeShadowed) { continue }
        $out += [pscustomobject]@{ Version = $i.Version; Path = $i.Path; Source = $i.Source; Shadowed = $shadowed; UsedPath = $firstOf[$i.Version] }
    }
    return $out
}

function Get-JdkMajor([string]$JavaHome) {
    # Major version of a JDK folder: JAVA_VERSION in its 'release' file, else 'java -version'. 0 if unknown.
    if (-not $JavaHome) { return 0 }
    $ver = $null
    $rel = [IO.Path]::Combine($JavaHome, 'release')
    if ([IO.File]::Exists($rel)) {
        $m = Select-String -LiteralPath $rel -Pattern '^JAVA_VERSION="?([0-9][0-9._]*)' | Select-Object -First 1
        if ($m) { $ver = $m.Matches[0].Groups[1].Value }
    }
    if (-not $ver) {
        $java = [IO.Path]::Combine($JavaHome, 'bin\java.exe')
        if ([IO.File]::Exists($java)) {
            # Merge stderr inside cmd: PS 5.1 turns native stderr into errors under ErrorActionPreference Stop.
            $out = (cmd /c "`"$java`" -version 2>&1") -join ' '
            if ($out -match 'version "([0-9][0-9._]*)') { $ver = $Matches[1] }
        }
    }
    if (-not $ver) { return 0 }
    $p = $ver -split '[._]'
    if ($p[0] -eq '1' -and $p.Count -gt 1) { return [int]$p[1] }   # 1.8.0_x -> 8
    return [int]$p[0]
}

function ConvertFrom-UnityPrefs([hashtable]$Values) {
    # Unity > Preferences > External Tools from EditorPrefs values (name without the _h<hash> suffix -> value).
    # A part counts as external when "Installed with Unity" is off (JdkUseEmbedded / SdkUseEmbedded / NdkUseEmbedded = 0;
    # a missing value means on) and its path is an existing folder. Returns Jdk / Sdk / Ndk = that folder or $null.
    $useEmbedded = { param($n) if (-not $Values.ContainsKey($n)) { return $true }; try { return [int]$Values[$n] -ne 0 } catch { return $true } }
    $dirOf = { param($v) $d = Get-CleanEnvPath "$v"; if ($d -and [IO.Directory]::Exists($d)) { $d } else { $null } }
    $r = [pscustomobject]@{ Jdk = $null; Sdk = $null; Ndk = $null }
    if (-not (& $useEmbedded 'JdkUseEmbedded')) { $r.Jdk = & $dirOf $Values['JdkPath'] }
    if (-not (& $useEmbedded 'SdkUseEmbedded')) { $r.Sdk = & $dirOf $Values['AndroidSdkRoot'] }
    if (-not (& $useEmbedded 'NdkUseEmbedded')) {
        # The NDK path is stored per required NDK release (AndroidNdkRootR23B, AndroidNdkRootR27C, ...): take the newest that exists.
        foreach ($n in @($Values.Keys | Where-Object { $_ -like 'AndroidNdkRoot*' } | Sort-Object -Descending)) {
            $d = & $dirOf $Values[$n]
            if ($d) { $r.Ndk = $d; break }
        }
    }
    return $r
}

function Get-UnityExternalAndroidTools {
    # EditorPrefs live in HKCU\Software\Unity Technologies\Unity Editor 5.x, shared by every editor version. Each value
    # name carries a _h<hash> suffix (JdkUseEmbedded_h1234...); strings are REG_BINARY UTF-8 ending in a null byte,
    # bools are DWORD. Cached per process.
    if ($script:ExternalToolsCache) { return $script:ExternalToolsCache }
    $vals = @{}
    $key = $null
    try { $key = Get-Item -LiteralPath $UnityPrefsKey -ErrorAction Stop } catch { }
    if ($key) {
        foreach ($n in $key.GetValueNames()) {
            if (-not ($n -match '^(JdkUseEmbedded|SdkUseEmbedded|NdkUseEmbedded|JdkPath|AndroidSdkRoot|AndroidNdkRoot[A-Za-z0-9]*)_h\d+$')) { continue }
            $base = $Matches[1]
            $v = $key.GetValue($n)
            if ($v -is [byte[]]) { $v = [Text.Encoding]::UTF8.GetString($v).TrimEnd([char]0) }
            $vals[$base] = $v
        }
    }
    $script:ExternalToolsCache = ConvertFrom-UnityPrefs $vals
    return $script:ExternalToolsCache
}

function Get-UnityAndroidMissing([string]$EditorPath, [switch]$BundledOnly) {
    # Parts of Unity Hub "Android Build Support" this lab needs; empty = complete. Hub installs OpenJDK and
    # "Android SDK & NDK Tools" as separate sub-modules, so either can be missing.
    # A part that Unity > Preferences > External Tools points at an existing folder counts as present (the build uses
    # that one), unless -BundledOnly: setup-android-sdk.ps1 and aapt2 need the bundled files themselves.
    # The AndroidPlayer module itself is always required.
    $ap = [IO.Path]::Combine($EditorPath, 'Editor\Data\PlaybackEngines\AndroidPlayer')
    $need = [ordered]@{
        'OpenJDK'           = 'OpenJDK\bin\java.exe'              # JAVA_HOME for sdkmanager/avdmanager and Gradle
        'SDK cmdline-tools' = 'SDK\cmdline-tools\*\bin\sdkmanager.bat'  # bootstraps the standalone SDK
        'SDK build-tools'   = 'SDK\build-tools\*\aapt2.exe'       # aapt2 (APK package name) and Gradle
        'NDK'               = 'NDK\source.properties'             # IL2CPP builds
    }
    $miss = @($need.Keys | Where-Object { -not @(Find-PathPattern $ap $need[$_]).Count })
    if ($BundledOnly -or -not $miss.Count -or -not [IO.Directory]::Exists($ap)) { return $miss }
    $ext = Get-UnityExternalAndroidTools
    $cover = @{ 'OpenJDK' = $ext.Jdk; 'SDK cmdline-tools' = $ext.Sdk; 'SDK build-tools' = $ext.Sdk; 'NDK' = $ext.Ndk }
    return @($miss | Where-Object { -not $cover[$_] })
}

function Get-UnityAndroidPlayer([string]$Version, [int]$MinJdk = 0) {
    # Newest installed editor with complete bundled Android Build Support (OpenJDK >= MinJdk), or the requested version.
    # Tool lookups (JDK, cmdline-tools, aapt2) may use any copy of a version, also one a higher-priority copy shadows.
    $full = @($dirs | Where-Object { (Get-UnityAndroidMissing $_.Path -BundledOnly).Count -eq 0 })
    if (-not $full) {
        $detail = ($dirs | ForEach-Object { "$($_.Version) missing $((Get-UnityAndroidMissing $_.Path -BundledOnly) -join ', ')" }) -join '; '
        throw "No Unity editor with complete Android Build Support (OpenJDK + Android SDK & NDK Tools) found (version='$Version'). $detail. Add them in Unity Hub > Installs > (version) > Add modules."
    }
    if ($MinJdk -gt 0) {
        $jdkOf = { param($e) Get-JdkMajor ([IO.Path]::Combine($e.Path, 'Editor\Data\PlaybackEngines\AndroidPlayer\OpenJDK')) }
        $ok = @($full | Where-Object { (& $jdkOf $_) -ge $MinJdk })
        if (-not $ok) {
            # Unity 6 (6000+) bundles JDK 17; 2023.x and earlier bundle JDK 11. An installed editor that already has a
            # new enough OpenJDK, or a Unity 6 that only lacks the OpenJDK / Android sub-modules, just needs modules
            # added: name it instead of asking for a new editor. Look at every install, not only the -UnityVersion filter.
            $partial = @(Get-UnityInstalls -IncludeShadowed | Where-Object {
                $m = @(Get-UnityAndroidMissing $_.Path -BundledOnly)
                $m.Count -gt 0 -and (($m -notcontains 'OpenJDK' -and (& $jdkOf $_) -ge $MinJdk) -or
                                     ($m -contains 'OpenJDK' -and (Get-UnityMajor $_.Version) -ge 6000)) })
            if ($Version) {
                # A complete editor outside the -UnityVersion filter may already have the JDK.
                $other = @(Get-UnityInstalls -IncludeShadowed | Where-Object { (Get-UnityAndroidMissing $_.Path -BundledOnly).Count -eq 0 -and (& $jdkOf $_) -ge $MinJdk }) | Select-Object -First 1
                if ($other) { throw "Unity $Version bundles an OpenJDK older than $MinJdk; Unity $($other.Version) (JDK $(& $jdkOf $other)) is installed: omit -UnityVersion or pass -UnityVersion $($other.Version)." }
            }
            if ($partial) {
                $detail = ($partial | ForEach-Object { "Unity $($_.Version) lacks $((Get-UnityAndroidMissing $_.Path -BundledOnly) -join ', ')" }) -join '; '
                throw "avdmanager needs Java $MinJdk+. $detail. Add the missing parts of Android Build Support in Unity Hub > Installs > (that version) > Add modules; no new editor is needed."
            }
            throw "avdmanager in cmdline-tools;latest needs Java $MinJdk+, but every Unity editor with Android Build Support here bundles an older OpenJDK (Unity 2023.x and earlier: JDK 11). Install a Unity 6 editor (e.g. 6000.6.0f1, the sample's version) with Android Build Support in Unity Hub; the project can keep its own editor."
        }
        $full = $ok
    }
    $pick = $full | Sort-Object { Get-UnityVersionKey $_.Version } -Descending | Select-Object -First 1
    return [IO.Path]::Combine($pick.Path, 'Editor\Data\PlaybackEngines\AndroidPlayer')
}

function Find-JdkFallback([int]$MinJdk = 0) {
    # A JDK >= MinJdk outside Unity's bundle: the one set in Unity > Preferences > External Tools, else JAVA_HOME as this
    # process got it. @{ Home; Major; Source } or $null.
    $cands = @()
    $ext = Get-UnityExternalAndroidTools
    if ($ext.Jdk) { $cands += [pscustomobject]@{ Home = $ext.Jdk; Source = 'Unity External Tools JDK' } }
    $jh = Get-CleanEnvPath $OrigJavaHome
    if ($jh) { $cands += [pscustomobject]@{ Home = $jh; Source = 'JAVA_HOME' } }
    foreach ($c in $cands) {
        if (-not [IO.File]::Exists([IO.Path]::Combine($c.Home, 'bin\java.exe'))) { continue }
        $major = Get-JdkMajor $c.Home
        if ($major -gt 0 -and $major -ge $MinJdk) { return [pscustomobject]@{ Home = $c.Home; Major = $major; Source = $c.Source } }
    }
    return $null
}

function Use-UnityJdk([string]$Version, [int]$MinJdk = 0) {
    # JAVA_HOME = the OpenJDK bundled with Unity's Android Build Support; when no editor has a fitting one, a JDK set in
    # Unity's External Tools or the JAVA_HOME already set (Find-JdkFallback). Also sets the Android variables.
    try { $env:JAVA_HOME = [IO.Path]::Combine((Get-UnityAndroidPlayer $Version $MinJdk), 'OpenJDK') }
    catch {
        $why = $_.Exception.Message
        $alt = Find-JdkFallback $MinJdk
        if (-not $alt) { throw "$why (No JDK$(if ($MinJdk) { " $MinJdk+" }) in Unity External Tools or JAVA_HOME either.)" }
        Write-Host "JAVA_HOME: no bundled Unity OpenJDK fits, using $($alt.Source) $($alt.Home) (JDK $($alt.Major))"
        $env:JAVA_HOME = $alt.Home
    }
    Set-AndroidEnv
}

function Find-BootstrapSdkManager([string]$Version) {
    # A sdkmanager.bat that can install cmdline-tools;latest into the lab SDK: the cmdline-tools bundled with Unity's
    # Android Build Support (that version first when given, newest editor first), else the External Tools SDK's own.
    $eds = @(Get-UnityInstalls -IncludeShadowed | Sort-Object { Get-UnityVersionKey $_.Version } -Descending)
    if ($Version) { $eds = @($eds | Where-Object Version -eq $Version) + @($eds | Where-Object Version -ne $Version) }
    $sdks = @($eds | ForEach-Object { [IO.Path]::Combine($_.Path, 'Editor\Data\PlaybackEngines\AndroidPlayer\SDK') })
    $ext = Get-UnityExternalAndroidTools
    if ($ext.Sdk) { $sdks += $ext.Sdk }
    foreach ($s in $sdks) {
        $hit = @(Find-PathPattern $s 'cmdline-tools\*\bin\sdkmanager.bat') | Sort-Object -Descending | Select-Object -First 1
        if ($hit) { return $hit }
    }
    return $null
}

function Get-UnityEditorForProject([string]$ProjectPath) {
    $pv = Join-Path $ProjectPath 'ProjectSettings\ProjectVersion.txt'
    if (-not (Test-Path -LiteralPath $pv)) { throw "Not a Unity project: $ProjectPath" }
    $ver = ((Get-Content -LiteralPath $pv | Select-String '^m_EditorVersion:') -split ':\s*')[1].Trim()
    # Get-UnityInstalls lists each version once, from the first place in its priority order.
    $install = Get-UnityInstalls | Where-Object Version -eq $ver | Select-Object -First 1
    if (-not $install) { throw "Unity $ver is not installed (project $ProjectPath). Install it with Unity Hub or set UNITY_EDITOR_ROOT." }
    return @{ Version = $ver; Exe = [IO.Path]::Combine($install.Path, 'Editor\Unity.exe'); Path = $install.Path }
}

function Test-ProjectLocked([string]$ProjectPath) {
    # True when a Unity (Editor or batchmode) holds the project: Temp\UnityLockfile exists and cannot be opened exclusively.
    $lock = [IO.Path]::Combine((ConvertTo-FullPath $ProjectPath), 'Temp\UnityLockfile')
    if (-not [IO.File]::Exists($lock)) { return $false }
    try { [IO.File]::Open($lock, 'Open', 'ReadWrite', 'None').Close(); return $false }
    catch [IO.FileNotFoundException] { return $false }
    catch [IO.DirectoryNotFoundException] { return $false }
    catch { return $true }
}

function Get-UnityProcessesForProject([string]$ProjectPath) {
    # Every running Unity.exe whose command line names this project with -projectPath:
    # @{ ProcessId; Batchmode; CommandLine; ParentProcessId; Worker }. Worker = an asset import worker
    # (-name AssetImportWorker*), a batchmode helper of an Editor or a build. A Unity of another Windows user or an
    # elevated one has no readable command line from a normal shell and is not listed.
    # Hub starts the Editor with  -projectpath C:\p ; import workers quote every token and use forward slashes:
    # "-batchMode" ... "-name" "AssetImportWorker0" "-projectPath" "C:/p".
    $want = Get-NormalizedPath $ProjectPath
    $found = @()
    foreach ($p in @(Get-CimInstance Win32_Process -Filter "Name='Unity.exe'" -ErrorAction SilentlyContinue)) {
        $cl = "$($p.CommandLine)"
        if (-not ($cl -match '(?i)(?:^|\s)"?-projectPath"?(?:\s+|=)(?:"([^"]*)"|(\S+))')) { continue }
        $val = if ($Matches[1]) { $Matches[1] } else { "$($Matches[2])" }
        if (-not $val -or -not [string]::Equals((Get-NormalizedPath $val), $want, [StringComparison]::OrdinalIgnoreCase)) { continue }
        $found += [pscustomobject]@{
            ProcessId       = [int]$p.ProcessId
            Batchmode       = [bool]($cl -match '(?i)(?:^|\s)"?-batchmode"?(?:\s|$)')
            CommandLine     = $cl
            ParentProcessId = [int]$p.ParentProcessId
            Worker          = [bool]($cl -match '(?i)(?:^|\s)"?-name"?\s+"?AssetImportWorker')
        }
    }
    return $found
}

function Get-DefaultBuildOut([string]$ProjectPath, [string]$Target) {
    # Build output when -Out is not given. The bundled sample keeps <sample>\Builds\Android\app.apk / Builds\WebGL /
    # Builds\Windows\app.exe. Any other project builds into this lab, outside the person's project and its git work tree:
    # artifacts\builds\<folder>-<hash8>\Android\app.apk, ...\WebGL or ...\Windows\app.exe. <folder> is the project folder
    # name with characters outside [A-Za-z0-9._-] replaced by '_'; <hash8> = first 8 hex chars of SHA256 over the UTF-8
    # bytes of the lowercased full path, so two projects with the same folder name do not share a folder.
    if ($Target -notin 'Android', 'WebGL', 'Windows') { throw "Get-DefaultBuildOut: Target must be Android, WebGL or Windows, not '$Target'." }
    $full = Get-NormalizedPath $ProjectPath
    $tail = @{ Android = 'Android\app.apk'; WebGL = 'WebGL'; Windows = 'Windows\app.exe' }[$Target]
    if ([string]::Equals($full, (Get-NormalizedPath $SampleRoot), [StringComparison]::OrdinalIgnoreCase)) {
        return [IO.Path]::Combine($full, 'Builds', $tail)
    }
    $leaf = [IO.Path]::GetFileName($full) -replace '[^A-Za-z0-9._-]', '_'
    if (-not $leaf) { $leaf = 'project' }
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $bytes = $sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($full.ToLowerInvariant())) } finally { $sha.Dispose() }
    $hash8 = -join ($bytes[0..3] | ForEach-Object { $_.ToString('x2') })
    return [IO.Path]::Combine($RepoRoot, 'artifacts', 'builds', "$leaf-$hash8", $tail)
}

function Get-WindowsDataDir([string]$Exe) {
    # A Windows player <dir>\<name>.exe loads its content from <dir>\<name>_Data.
    return [IO.Path]::Combine([IO.Path]::GetDirectoryName($Exe), [IO.Path]::GetFileNameWithoutExtension($Exe) + '_Data')
}

function Get-ProjectStandaloneBackend([string]$ProjectPath) {
    # 'IL2CPP' or 'Mono': the Windows (Standalone) scripting backend in ProjectSettings.asset. A project that never
    # changed it has no Standalone entry under scriptingBackend, which means Mono.
    $ps = [IO.Path]::Combine($ProjectPath, 'ProjectSettings\ProjectSettings.asset')
    if (-not [IO.File]::Exists($ps)) { return 'Mono' }
    $m = [regex]::Match([IO.File]::ReadAllText($ps), 'scriptingBackend:\s*\r?\n(?:\s+\w+:\s*\d+\r?\n)*?\s+Standalone:\s*(\d+)')
    if ($m.Success -and $m.Groups[1].Value -eq '1') { return 'IL2CPP' }
    return 'Mono'
}

function Get-UnityWindowsMissing([string]$EditorPath, [string]$Backend = 'Mono') {
    # Unity Hub modules a 64-bit Windows player build needs that this editor lacks; empty = complete. The Windows editor
    # comes with the Mono player ("Windows Build Support (Mono)"); IL2CPP is the separate "Windows Build Support (IL2CPP)".
    $v = [IO.Path]::Combine($EditorPath, 'Editor\Data\PlaybackEngines\WindowsStandaloneSupport\Variations')
    $miss = @()
    if (-not @(Find-PathPattern $v 'win64_*_mono').Count) { $miss += 'Windows Build Support (Mono)' }
    if ($Backend -eq 'IL2CPP' -and -not @(Find-PathPattern $v 'win64_*_il2cpp').Count) { $miss += 'Windows Build Support (IL2CPP)' }
    return $miss
}

function Test-Arm64Host {
    # Windows on ARM. A native process sees PROCESSOR_ARCHITECTURE=ARM64; an x86/x64 process running under emulation
    # sees its own architecture there, so also check PROCESSOR_ARCHITEW6432 and the CPU (Win32_Processor 12 = ARM64).
    if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') { return $true }
    try { return [bool](@(Get-CimInstance Win32_Processor -ErrorAction Stop)[0].Architecture -eq 12) } catch { return $false }
}

function Get-AccelAdvice {
    # What the person changes when emulator -accel-check finds no usable hypervisor. With Hyper-V running the firmware
    # flag reads False, so the hypervisor is checked first; BIOS/UEFI only when the firmware flag is really off.
    $cs = Get-CimInstance Win32_ComputerSystem
    $cpu = @(Get-CimInstance Win32_Processor)[0]
    if ($cs.HypervisorPresent) { return 'A hypervisor (Hyper-V) is already running, so only the Windows feature "Windows Hypervisor Platform" is missing: enable it (admin) and reboot' }
    if ($cpu.VirtualizationFirmwareEnabled -eq $false) { return 'CPU virtualization is off in firmware: enable Intel VT-x / AMD-V (SVM) in BIOS/UEFI, then the Windows feature "Windows Hypervisor Platform" (admin), and reboot' }
    return 'CPU virtualization is already on: enable the Windows feature "Windows Hypervisor Platform" (admin) and reboot'
}

function Get-ProxySetting([string]$Proxy) {
    # Proxy for sdkmanager (--proxy=http --proxy_host --proxy_port): -Proxy host:port, else HTTPS_PROXY, else HTTP_PROXY
    # (http://[user:pass@]host[:port][/]). @{ Host; Port; From; HasAuth } or $null when none is set.
    $raw = $Proxy; $from = '-Proxy'
    if (-not $raw) {
        foreach ($n in 'HTTPS_PROXY', 'HTTP_PROXY') {
            $v = [Environment]::GetEnvironmentVariable($n)
            if ($v) { $raw = $v; $from = "env $n"; break }
        }
    }
    if (-not $raw) { return $null }
    $s = $raw.Trim()
    $port = 80
    if ($s -match '^(?i)(https?)://') { if ($Matches[1] -ieq 'https') { $port = 443 }; $s = $s.Substring($Matches[0].Length) }
    $hasAuth = $s.Contains('@')
    if ($hasAuth) { $s = $s.Substring($s.LastIndexOf('@') + 1) }
    $s = $s.TrimEnd('/')
    if (-not ($s -match '^([A-Za-z0-9._-]+)(?::(\d{1,5}))?$') -or ($Matches[2] -and [int]$Matches[2] -gt 65535)) {
        # Only an explicit -Proxy is fatal. A proxy variable set for other tools (socks5://, IPv6, ...) may not be needed
        # for dl.google.com, and sdkmanager ignored these variables before, so warn and go on without --proxy.
        if ($from -eq '-Proxy') { throw "Proxy '$raw' ($from) is not host:port (e.g. proxy.example.com:8080)." }
        Write-Host "WARN ignoring $($from -replace '^env ', '')=$raw for sdkmanager: not http://host:port. If downloads fail, pass -Proxy host:port."
        return $null
    }
    if ($Matches[2]) { $port = [int]$Matches[2] }
    return [pscustomobject]@{ Host = $Matches[1]; Port = $port; From = $from; HasAuth = $hasAuth }
}

function Test-AdbServer {
    $client = New-Object Net.Sockets.TcpClient
    try { return $client.ConnectAsync('127.0.0.1', 5037).Wait(300) -and $client.Connected }
    catch { return $false } finally { $client.Dispose() }
}

function Start-AdbServer {
    # If no adb server is running, the next adb call forks one as OUR child, and it inherits our stdout pipe:
    # a caller capturing this script's output then waits until the server dies. Unity's Android build stops
    # the server when it finishes, so this happens right after every build. Start it detached instead.
    if (Test-AdbServer) { return }
    $logDir = Join-Path $RepoRoot 'artifacts'
    New-Item -ItemType Directory -Force $logDir | Out-Null
    $p = Start-Detached $Adb @('start-server') (Join-Path $logDir 'adb-start-server.log') $null
    $p.WaitForExit(15000) | Out-Null
    $deadline = (Get-Date).AddSeconds(10)
    while (-not (Test-AdbServer) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 300 }
}

function Invoke-Adb {
    Start-AdbServer
    # Run adb against the emulator serial in $env:EMU_SERIAL (or the only device).
    # adb writes progress (pull/push/install) to stderr; keep it as plain text instead of PS 5.1 error records.
    # adb prints UTF-8; PS 5.1 decodes native output with the console code page (CP949 here), which breaks
    # Korean notification titles, so switch to UTF-8 for the call.
    $ErrorActionPreference = 'Continue'
    $serialArgs = @()
    if ($env:EMU_SERIAL) { $serialArgs = @('-s', $env:EMU_SERIAL) }
    $prevEnc = $null
    try { $prevEnc = [Console]::OutputEncoding; [Console]::OutputEncoding = New-Object Text.UTF8Encoding $false } catch { }
    try {
        & $Adb @serialArgs @args 2>&1 | ForEach-Object {
            if ($_ -is [Management.Automation.ErrorRecord]) { $_.Exception.Message } else { $_ }
        }
    } finally {
        if ($prevEnc) { try { [Console]::OutputEncoding = $prevEnc } catch { } }
    }
}

function Get-DeviceEpochMs { [int64]((Invoke-Adb shell date +%s%3N) -join '').Trim() }

function Start-Detached([string]$Exe, [string[]]$ArgList, [string]$OutFile, [string]$ErrFile) {
    # Start-Process with -Redirect* inherits this process's stdout/stderr handles into the child, so a
    # long-lived child (emulator, logcat) keeps the caller's pipe open and callers that capture output hang.
    # Going through cmd via ShellExecute avoids handle inheritance; cmd does the redirection.
    # /s + outer quotes keep cmd from stripping the quotes around the redirect targets.
    # Quote every argument: inside quotes cmd keeps & | < > ^ ( ) as text. Double trailing backslashes so the
    # child's argv parser does not read \" as an escaped quote. cmd still expands %VAR% inside quotes and an
    # embedded " would end cmd's quoting, so refuse both instead of running a different command.
    foreach ($a in @($Exe, $OutFile, $ErrFile) + @($ArgList)) {
        if ("$a" -match '["%]') { throw "Start-Detached: unsupported character (double quote or percent) in: $a" }
    }
    $quoted = ($ArgList | ForEach-Object { '"' + ($_ -replace '(\\+)$', '$1$1') + '"' }) -join ' '
    $line = '""' + $Exe + '" ' + $quoted + ' > "' + $OutFile + '"'
    if ($ErrFile) { $line += ' 2> "' + $ErrFile + '"' } else { $line += ' 2>&1' }
    $line += '"'
    return Start-Process -FilePath $env:ComSpec -ArgumentList @('/d', '/s', '/c', $line) -WindowStyle Hidden -PassThru
}

function Stop-ProcessTree([int]$RootId, [Nullable[datetime]]$RootStarted) {
    # Windows reuses PIDs, and a process whose parent died keeps the dead parent's PID as ParentProcessId: when a new
    # process gets that PID, those orphans (e.g. a Code.exe started from a closed terminal) look like its children.
    # A real child is never created before its parent, so only children created at or after their parent are followed.
    # If the root has already exited its creation time is unknown: pass -RootStarted (e.g. the Process object's StartTime
    # taken right after starting it) to still stop its former children; without it they are left alone.
    $root = @(Get-CimInstance Win32_Process -Filter "ProcessId=$RootId" -ErrorAction SilentlyContinue)[0]
    $created = if ($root -and $root.CreationDate) { $root.CreationDate } elseif ($RootStarted) { $RootStarted.Value } else { $null }
    if ($created) { Stop-ChildProcessTrees $RootId $created }
    Stop-Process -Id $RootId -Force -ErrorAction SilentlyContinue
}

function Stop-ChildProcessTrees([int]$ParentId, [datetime]$ParentCreated) {
    # Leave an adb server alone if this tree happened to fork it; other tools share it.
    Get-CimInstance Win32_Process -Filter "ParentProcessId=$ParentId" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -notmatch 'fork-server' -and $_.CreationDate -and $_.CreationDate -ge $ParentCreated } |
        ForEach-Object {
            Stop-ChildProcessTrees ([int]$_.ProcessId) $_.CreationDate
            Stop-Process -Id ([int]$_.ProcessId) -Force -ErrorAction SilentlyContinue
        }
}

function Get-ApkPackage([string]$ApkPath) {
    # aapt2 from SDK build-tools: Unity's bundled SDK (newest editor first), the External Tools SDK, then the lab SDK.
    # $null when none is found (the caller then asks for -Package).
    $sdks = @(Get-UnityInstalls -IncludeShadowed | Sort-Object { Get-UnityVersionKey $_.Version } -Descending |
        ForEach-Object { [IO.Path]::Combine($_.Path, 'Editor\Data\PlaybackEngines\AndroidPlayer\SDK') })
    $ext = Get-UnityExternalAndroidTools
    if ($ext.Sdk) { $sdks += $ext.Sdk }
    $sdks += $SdkRoot
    $aapt2 = $null
    foreach ($s in $sdks) {
        $aapt2 = @(Find-PathPattern $s 'build-tools\*\aapt2.exe') |
            Sort-Object { [IO.Path]::GetFileName([IO.Path]::GetDirectoryName($_)) } -Descending | Select-Object -First 1
        if ($aapt2) { break }
    }
    if (-not $aapt2) { return $null }
    return ((& $aapt2 dump packagename $ApkPath) -join '').Trim()
}

function Get-ApkAbis([string]$ApkPath) {
    # Native ABIs packed in the APK (lib/<abi>/*.so). Empty when the APK has no native code.
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [IO.Compression.ZipFile]::OpenRead($ApkPath)
    try {
        return @($zip.Entries | ForEach-Object { if ($_.FullName -match '^lib/([^/]+)/[^/]+\.so$') { $Matches[1] } } | Sort-Object -Unique)
    } finally { $zip.Dispose() }
}

# System UI that sits on top of the app (first-run immersive hint, permission prompt, ...).
# Unity does not start its first frame until its window has focus, so these block every test.
$script:SystemDialogButtons = @('Got it', 'Allow', 'OK')

function Get-UiDump([int]$Attempts = 3) {
    # uiautomator leaves the previous file in place when a dump fails (e.g. "could not get idle state"),
    # so delete it first and only trust a dump that reports success. Returns the XML text or $null.
    for ($i = 0; $i -lt $Attempts; $i++) {
        Invoke-Adb shell rm -f /sdcard/__ui.xml | Out-Null
        $out = (Invoke-Adb shell uiautomator dump /sdcard/__ui.xml) -join ' '
        if ($out -match 'dumped to') {
            $xml = (Invoke-Adb shell cat /sdcard/__ui.xml) -join ''
            if ($xml -match '<hierarchy') { return $xml }
        }
        # Only one UiAutomation client can exist. mobile-mcp leaves an on-device helper
        # (com.mobilenext.mobilecli.DeviceServer, 30 min idle timeout) that makes uiautomator die with 137.
        $holder = (Invoke-Adb shell pgrep -f com.mobilenext.mobilecli.DeviceServer) -join ' '
        if ($holder -match '\d') {
            Invoke-Adb shell pkill -f com.mobilenext.mobilecli.DeviceServer | Out-Null
            Write-Host "UI_DUMP stopped mobile-mcp DeviceServer (pid $holder) that held UiAutomation"
        }
        Start-Sleep -Seconds 1
    }
    Write-Host "UI_DUMP_FAILED $out"
    return $null
}

function Resolve-SystemDialog([string]$AppPackage, [string]$LogPath) {
    $xml = Get-UiDump
    if (-not $xml) { return $null }
    foreach ($label in $SystemDialogButtons) {
        $pattern = 'text="' + [regex]::Escape($label) + '"[^>]*?package="([^"]+)"[^>]*?bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"'
        $m = [regex]::Match($xml, $pattern)
        if ($m.Success -and $m.Groups[1].Value -ne $AppPackage) {
            $x = ([int]$m.Groups[2].Value + [int]$m.Groups[4].Value) / 2
            $y = ([int]$m.Groups[3].Value + [int]$m.Groups[5].Value) / 2
            Invoke-Adb shell input tap $x $y | Out-Null
            $note = "$(Get-Date -Format HH:mm:ss) tapped '$label' in $($m.Groups[1].Value) at $x,$y"
            if ($LogPath) { Add-Content -LiteralPath $LogPath -Value $note -Encoding ASCII }
            Write-Host "SYSTEM_DIALOG $note"
            return $label
        }
    }
    return $null
}

function Get-EmulatorAvdName([string]$Serial) {
    # PS 5.1 + EAP Stop turns redirected native stderr into a terminating error; keep it local.
    $ErrorActionPreference = 'Continue'
    $lines = @(& $Adb -s $Serial emu avd name 2>$null | ForEach-Object { "$_".Trim() } | Where-Object { $_ })
    if ($lines.Count -and $lines[0] -ne 'OK' -and $lines[0] -notmatch '^KO') { return $lines[0] }
    $p = ((& $Adb -s $Serial shell getprop ro.boot.qemu.avd_name 2>$null) -join '').Trim()
    if ($p) { return $p }
    return $null
}

function Get-RunningEmulators {
    # @{ Serial; Avd } for every emulator adb sees as "device".
    Start-AdbServer
    & $Adb devices | Select-String '^emulator-\d+\s+device' | ForEach-Object {
        $s = ($_.Line -split '\s+')[0]
        [pscustomobject]@{ Serial = $s; Avd = (Get-EmulatorAvdName $s) }
    }
}

function Get-EmulatorSerial([int]$WaitSec = 0, [string]$AvdName = $DefaultAvd) {
    # Only the test AVD: never pick another emulator (e.g. a personal Android Studio AVD).
    # A freshly (re)started adb server needs a few seconds before the emulator shows up as "device".
    $deadline = (Get-Date).AddSeconds($WaitSec)
    do {
        $hit = @(Get-RunningEmulators | Where-Object { $_.Avd -eq $AvdName }) | Select-Object -First 1
        if ($hit) { return $hit.Serial }
        if ($WaitSec -gt 0) { Start-Sleep -Seconds 2 }
    } while ((Get-Date) -lt $deadline)
    return $null
}

function Get-LauncherActivity([string]$Package) {
    $out = Invoke-Adb shell cmd package resolve-activity --brief -c android.intent.category.LAUNCHER $Package
    $act = ($out | Where-Object { $_ -match '/' } | Select-Object -Last 1)
    if (-not $act) { throw "Launcher activity not found for $Package" }
    return $act.Trim()
}

function New-RunDir([string]$Name) {
    # One directory per run, never shared: runs started in the same second (parallel agents) would otherwise
    # share a browser profile and overwrite each other's logs. $PID keeps processes apart; the counter keeps
    # calls within one process apart.
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $base = Join-Path $RepoRoot "artifacts\$stamp-$Name-$PID"
    $dir = $base
    $n = 1
    while (Test-Path -LiteralPath $dir) { $n++; $dir = "$base-$n" }
    New-Item -ItemType Directory -Force $dir | Out-Null
    return $dir
}

function Start-Watchdog([string]$RunDir) {
    # Windows does not stop children when their parent dies. If this script is killed before its finally block
    # runs (tool timeout, closed console, Stop-Process), the watchdog stops every process whose command line
    # names the run dir (static server, browser profile, logcat redirect). Stop it last in your finally block.
    return Start-Detached 'powershell.exe' @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
        (Join-Path $PSScriptRoot 'watch-parent.ps1'), '-ParentPid', "$PID", '-Match', $RunDir) (Join-Path $RunDir 'watchdog.log') $null
}

function Save-Screenshot([string]$Path) {
    # exec-out keeps PNG bytes intact on Windows; go through a temp file on device to avoid pipe encoding issues.
    Invoke-Adb shell screencap -p /sdcard/__shot.png | Out-Null
    Invoke-Adb pull /sdcard/__shot.png $Path | Out-Null
    Invoke-Adb shell rm /sdcard/__shot.png | Out-Null
}

# --- Device lease: one session at a time per AVD
# A lease is one file, <lease home>\leases\<avd>.json, created with FileMode.CreateNew so two sessions cannot both take
# it. start-emulator.ps1 takes (or renews) it; release-emulator.ps1 resets what test runs change on the device and gives
# it back. smoke-test / check-notification / time-travel stop while another owner holds a valid lease. A lease runs out
# after start-emulator.ps1 -Hours (running it again renews); the next start-emulator.ps1 then takes it over.
# Lease home: EMU_LAB_HOME, else %USERPROFILE%\.emu-lab (outside AppData, which packaged AI apps redirect).
$script:LeaseHome = if ($env:EMU_LAB_HOME) { Get-CleanEnvPath $env:EMU_LAB_HOME } else { [IO.Path]::Combine($env:USERPROFILE, '.emu-lab') }

function Get-EmuOwner {
    # The same owner ids as unity-slot: EMU_OWNER, claude:<session id first 8>, codex:<thread id last 8>, else user@host.
    if ($env:EMU_OWNER -and $env:EMU_OWNER.Trim()) { return $env:EMU_OWNER.Trim() }
    if ($env:CLAUDE_CODE_SESSION_ID) { $s = $env:CLAUDE_CODE_SESSION_ID; return 'claude:' + $s.Substring(0, [Math]::Min(8, $s.Length)) }
    if ($env:CODEX_THREAD_ID) { $t = $env:CODEX_THREAD_ID; return 'codex:' + $t.Substring([Math]::Max(0, $t.Length - 8)) }
    return "$env:USERNAME@$env:COMPUTERNAME"
}

function Get-EmuLeasePath([string]$Avd = $DefaultAvd) { return [IO.Path]::Combine($LeaseHome, 'leases', "$Avd.json") }

function ConvertTo-LeaseDate($Value) {
    # Lease times are ISO 8601 strings; a JSON reader may already have turned them into DateTime.
    if ($Value -is [datetime]) { return [DateTimeOffset]$Value }
    return [DateTimeOffset]::Parse("$Value", [Globalization.CultureInfo]::InvariantCulture)
}

function Read-EmuLease([string]$Avd = $DefaultAvd) {
    # The lease as an object, or $null. A file another session is writing can be locked or empty for a moment.
    $path = Get-EmuLeasePath $Avd
    $why = $null
    for ($i = 0; $i -lt 6; $i++) {
        if (-not [IO.File]::Exists($path)) { return $null }
        try {
            $text = [IO.File]::ReadAllText($path, [Text.Encoding]::UTF8)
            if ($text.Trim()) { return ($text | ConvertFrom-Json) }
            $why = 'it is empty'
        } catch { $why = $_.Exception.Message }
        Start-Sleep -Milliseconds 300
    }
    throw "Cannot read the lease file $path ($why). Look at it; delete it only when no session uses the emulator."
}

function Test-EmuLeaseValid($Lease) {
    if (-not $Lease) { return $false }
    try { return (ConvertTo-LeaseDate $Lease.expiresAt) -gt [DateTimeOffset]::Now } catch { return $true }
}

function ConvertTo-LeaseTable($Lease) {
    $h = [ordered]@{}
    foreach ($p in $Lease.PSObject.Properties) { $h[$p.Name] = $p.Value }
    return $h
}

function Write-EmuLease([string]$Avd, $Table, [switch]$New) {
    # -New: create the file only if it does not exist (the lock). Otherwise replace it in one step.
    $path = Get-EmuLeasePath $Avd
    [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($path))
    $bytes = (New-Object Text.UTF8Encoding $false).GetBytes((([pscustomobject]$Table) | ConvertTo-Json -Depth 4) + "`r`n")
    $target = if ($New) { $path } else { "$path.$PID.tmp" }
    $mode = if ($New) { [IO.FileMode]::CreateNew } else { [IO.FileMode]::Create }
    $fs = [IO.File]::Open($target, $mode, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try { $fs.Write($bytes, 0, $bytes.Length) } finally { $fs.Dispose() }
    if (-not $New) {
        # [NullString]::Value: a plain $null reaches .NET as "" (an illegal backup path).
        try { [IO.File]::Replace($target, $path, [NullString]::Value) }
        catch { Remove-Item -LiteralPath $target -Force -ErrorAction SilentlyContinue; throw }
    }
}

function Get-EmuBusyMessage($Lease, [string]$Avd) {
    return "BUSY: AVD '$Avd' is leased by $($Lease.owner) (host $($Lease.host), since $($Lease.acquiredAt), until $($Lease.expiresAt)). " +
        'Another session is using the emulator: do not install, tap or change its settings. Wait, or ask the person; ' +
        "only the person releases someone else's lease (release-emulator.ps1 -AnyOwner)."
}

function Enter-EmuLease([string]$Owner, [double]$Hours, [string]$Avd = $DefaultAvd) {
    # Take or renew the lease. Returns @{ Action = 'new' | 'renewed' | 'takeover'; Lease = <ordered table> }.
    # Throws BUSY: ... while another owner holds a valid lease.
    $now = [DateTimeOffset]::Now
    $until = $now.AddHours($Hours).ToString('o')
    $cur = Read-EmuLease $Avd
    if ($cur -and $cur.owner -eq $Owner) {
        $t = ConvertTo-LeaseTable $cur
        $t.expiresAt = $until
        Write-EmuLease $Avd $t
        return @{ Action = 'renewed'; Lease = $t }
    }
    $action = 'new'
    if ($cur) {
        if (Test-EmuLeaseValid $cur) { throw (Get-EmuBusyMessage $cur $Avd) }
        $action = 'takeover'
        Write-Host "LEASE_TAKEOVER the lease of $($cur.owner) ran out at $($cur.expiresAt); taking it over (an emulator it started keeps running)"
        Remove-Item -LiteralPath (Get-EmuLeasePath $Avd) -Force -ErrorAction SilentlyContinue
    }
    $t = [ordered]@{
        avd = $Avd; owner = $Owner; host = $env:COMPUTERNAME
        acquiredAt = $now.ToString('o'); expiresAt = $until
        startedEmulator = $false; emulatorPid = $null; emulatorStartedAt = $null
        installed = @()
    }
    try { Write-EmuLease $Avd $t -New }
    catch {
        # Another session created the file between our read and our create.
        $other = $null
        try { $other = Read-EmuLease $Avd } catch { }
        if ($other -and $other.owner -ne $Owner) { throw (Get-EmuBusyMessage $other $Avd) }
        throw
    }
    return @{ Action = $action; Lease = $t }
}

function Update-EmuLease([hashtable]$Set, [string]$Owner, [string]$Avd = $DefaultAvd) {
    # Change fields of our own lease. $false when the lease is gone or someone else's.
    if (-not $Owner) { $Owner = Get-EmuOwner }
    $cur = Read-EmuLease $Avd
    if (-not $cur -or $cur.owner -ne $Owner) { return $false }
    $t = ConvertTo-LeaseTable $cur
    foreach ($k in $Set.Keys) { $t[$k] = $Set[$k] }
    Write-EmuLease $Avd $t
    return $true
}

function Assert-EmuLeaseUsable([string]$Avd = $DefaultAvd) {
    # Scripts that change the device call this first. Another owner's valid lease stops them (BUSY); without a lease
    # (a person running a script by hand) they only warn, once per process. Returns our lease or $null.
    $owner = Get-EmuOwner
    $cur = Read-EmuLease $Avd
    if ($cur -and (Test-EmuLeaseValid $cur)) {
        if ($cur.owner -ne $owner) { throw (Get-EmuBusyMessage $cur $Avd) }
        return $cur
    }
    if (-not $global:EmuLeaseWarned) {
        $global:EmuLeaseWarned = $true
        $why = if ($cur) { "the lease of $($cur.owner) ran out at $($cur.expiresAt)" } else { 'no session holds it' }
        Write-Host "LEASE_NONE AVD '$Avd' is not leased ($why). Run scripts\start-emulator.ps1 first so other sessions see the emulator as busy, and scripts\release-emulator.ps1 when done."
    }
    return $null
}

function Add-EmuLeaseInstalled([string]$Package, [string]$Avd = $DefaultAvd) {
    # Remember an app installed under our lease, so release-emulator.ps1 -Uninstall can remove it.
    $cur = Read-EmuLease $Avd
    if (-not $cur -or $cur.owner -ne (Get-EmuOwner)) { return }
    $list = @(@($cur.installed) | Where-Object { $_ })
    if ($list -notcontains $Package) { $list += $Package }
    [void](Update-EmuLease @{ installed = $list } -Avd $Avd)
}
