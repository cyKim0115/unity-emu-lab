# Install a standalone Android SDK (emulator + x86_64 system image) and create an AVD.
# Uses the OpenJDK and cmdline-tools bundled with Unity's Android Build Support to bootstrap (a JDK 17+ from Unity's
# External Tools or JAVA_HOME also works). Idempotent: re-running skips what is already installed.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\setup-android-sdk.ps1 -AcceptLicenses
#   setup-android-sdk.ps1 -AcceptLicenses -SdkRoot C:\Android\Sdk -AvdHome C:\Android\avd   # other folders, kept for later commands
#   setup-android-sdk.ps1 -AcceptLicenses -Proxy proxy.example.com:8080                      # else HTTPS_PROXY / HTTP_PROXY
#
# -SdkRoot / -AvdHome are saved in local.settings.json (this lab only, not committed), so doctor, start-emulator and
# run-all keep using them without a global environment change. ANDROID_SDK_ROOT / ANDROID_AVD_HOME win
# over that file when set.
# Ends with "SETUP_DONE accel=ok" (exit 0), or "[HUMAN] emulator-accel: ..." + "SETUP_DONE accel=missing" (exit 2):
# the SDK is installed but the emulator cannot run until the person enables virtualization.
param(
    [int]$ApiLevel = 35,
    [string]$ImageTag = 'google_apis',   # google_apis allows 'adb root'; google_apis_playstore does not
    [string]$AvdName = 'unity-test',
    [string]$Device = 'pixel_7',
    [string]$UnityVersion,
    [string]$SdkRoot,
    [string]$AvdHome,
    [string]$Proxy,
    [switch]$AcceptLicenses
)
# common.ps1 sets $SdkRoot / $AvdHome in this scope; keep the arguments first.
$argSdkRoot = $SdkRoot
$argAvdHome = $AvdHome
. "$PSScriptRoot\common.ps1"

if (Test-Arm64Host) {
    throw 'Windows on ARM (ARM64): the x86_64 emulator and system image this lab installs cannot run accelerated here. Nothing installed. Use -Target WebGL, or test Android on a real device.'
}
Set-LabAndroidLocations $argSdkRoot $argAvdHome
if ($SdkRoot -match '[%"]') { throw "SDK root '$SdkRoot' contains % or a double quote, which cmd cannot pass to sdkmanager. Choose another folder with -SdkRoot." }
$px = Get-ProxySetting $Proxy
$proxyArgs = ''
if ($px) {
    $proxyArgs = " --proxy=http --proxy_host=$($px.Host) --proxy_port=$($px.Port)"
    Write-Host "Proxy    : $($px.Host):$($px.Port) (from $($px.From))"
    if ($px.HasAuth) { Write-Host 'Proxy    : the user name/password in the proxy URL is not passed (sdkmanager has no option for it).' }
}

# cmdline-tools;latest: sdkmanager runs on the Android CLI's own JRE, but avdmanager uses JAVA_HOME and needs 17+
# (Unity 2023.x and earlier bundle JDK 11). This check runs before any license prompt or download.
Use-UnityJdk $UnityVersion 17
Write-Host "SDK root : $SdkRoot (from $SdkRootSource)"
Write-Host "AVD home : $AvdHome (from $AvdHomeSource)"
Write-Host "JAVA_HOME: $env:JAVA_HOME"
New-Item -ItemType Directory -Force $SdkRoot | Out-Null

if (-not $AcceptLicenses) {
    throw 'Installing SDK packages requires accepting the Android SDK license. Re-run with -AcceptLicenses.'
}
# sdkmanager ignores stdin piped from PowerShell; go through cmd input redirection instead.
$yesFile = Join-Path $env:TEMP 'sdkmanager-yes.txt'
[IO.File]::WriteAllText($yesFile, ((@('y') * 40) -join "`r`n") + "`r`n")
# Double a trailing backslash (bare drive root) so the quoted value does not end in \".
$sdkArg = $SdkRoot -replace '(\\+)$', '$1$1'
function Invoke-SdkManagerYes([string]$Tool, [string[]]$Packages) {
    $pkgs = ($Packages | ForEach-Object { "`"$_`"" }) -join ' '
    # cmdline-tools 23+ prints a deprecation warning on stderr; merge it inside cmd so PS 5.1 does not throw.
    cmd /c "`"$Tool`" --sdk_root=`"$sdkArg`"$proxyArgs $pkgs < `"$yesFile`" 2>&1" |
        Select-String -NotMatch '^\s*$|^\[=' | Select-Object -Last 4 | ForEach-Object { Write-Host $_.Line }
    if ($LASTEXITCODE -ne 0) {
        $net = if ($proxyArgs) { '' } else { ' If the same download also fails in the person''s normal terminal, the network may need a proxy: ask for it and rerun with -Proxy host:port.' }
        throw "sdkmanager failed ($LASTEXITCODE): $pkgs.$net"
    }
}

if (-not (Test-Path -LiteralPath $SdkManager)) {
    $boot = Find-BootstrapSdkManager $UnityVersion
    if (-not $boot) { throw "No sdkmanager to bootstrap from: add 'Android SDK & NDK Tools' of Android Build Support to an editor in Unity Hub > Installs > (version) > Add modules." }
    Write-Host "Bootstrapping cmdline-tools;latest with $boot"
    Invoke-SdkManagerYes $boot @('cmdline-tools;latest')
    if (-not (Test-Path -LiteralPath $SdkManager)) { throw 'cmdline-tools;latest install failed.' }
}

$image = "system-images;android-$ApiLevel;$ImageTag;x86_64"
Write-Host "Installing: platform-tools emulator $image"
Invoke-SdkManagerYes $SdkManager @('platform-tools', 'emulator', $image)

[void][IO.Directory]::CreateDirectory($AvdHome)
$avdDir = [IO.Path]::Combine($AvdHome, "$AvdName.avd")
if (-not (Test-Path -LiteralPath ([IO.Path]::Combine($avdDir, 'config.ini')))) {
    Write-Host "Creating AVD $AvdName ($Device, $image)"
    'no' | & $AvdManager create avd -n $AvdName -k $image -d $Device --force
    # avdmanager.bat exits 0 when Java is too old, so check the result, not only the exit code.
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath ([IO.Path]::Combine($avdDir, 'config.ini')))) {
        throw "avdmanager did not create $avdDir (exit $LASTEXITCODE, JAVA_HOME=$env:JAVA_HOME). It needs Java 17+."
    }
}

# Tune the AVD for game testing: host GPU, more RAM/storage, hardware keyboard.
$cfg = [IO.Path]::Combine($avdDir, 'config.ini')
$want = [ordered]@{
    'hw.gpu.enabled' = 'yes'
    'hw.gpu.mode' = 'host'
    'hw.ramSize' = '4096'
    'disk.dataPartition.size' = '8G'
    'hw.keyboard' = 'yes'
    'fastboot.forceColdBoot' = 'no'
}
$lines = Get-Content -LiteralPath $cfg
foreach ($k in $want.Keys) {
    $pattern = '^' + [regex]::Escape($k) + '\s*='
    if ($lines -match $pattern) { $lines = $lines -replace ($pattern + '.*$'), "$k=$($want[$k])" }
    else { $lines += "$k=$($want[$k])" }
}
Set-Content -LiteralPath $cfg -Value $lines -Encoding ASCII

Write-Host '--- emulator -accel-check'
# Merge stderr inside cmd: PS 5.1 turns native stderr into errors under ErrorActionPreference Stop.
$accelLines = @(cmd /c "`"$EmulatorExe`" -accel-check 2>&1" | ForEach-Object { "$_" })
$accelLines | ForEach-Object { Write-Host $_ }
Write-Host '--- AVDs'
& $EmulatorExe -list-avds
$accel = ($accelLines -join ' ').Trim()
if ($accel -match $AccelOkPattern) {
    Write-Host 'SETUP_DONE accel=ok'
    exit 0
}
Write-Host "[HUMAN] emulator-accel: the SDK is installed, but the emulator has no usable hypervisor: $accel. $(Get-AccelAdvice). Then rerun scripts\doctor.ps1."
Write-Host 'SETUP_DONE accel=missing'
exit 2
