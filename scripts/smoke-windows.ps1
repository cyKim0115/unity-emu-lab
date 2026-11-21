# Self-test a Unity Windows player on this desktop, from outside the game: start the exe windowed with its log in
# the run folder (-logFile <run>\Player.log) -> wait for a log marker -> (only with -Tap) click a point with the real
# mouse -> screenshots of the player window -> close it. Crashes, managed exceptions, error dialogs and a player that
# quits by itself are told apart.
# Results: artifacts\<stamp>-windows-<pid>\ (Player.log, PNG screenshots, summary.json). Exit 0 on PASS, 1 on FAIL.
# Only the player this run started is closed (WM_CLOSE first, then stopped with its child processes).
#
#   smoke-windows.ps1 -Exe sample\EmuSmoke\Builds\Windows\app.exe
#   smoke-windows.ps1 -Exe <game.exe> -ReadyMarker "<Player.log line>"
#   smoke-windows.ps1 -Exe <game.exe> -ReadyMarker "<line>" -Tap -TapX 0.5 -TapY 0.8 -TapMarker "<line the tap logs>"
#   powershell -NoProfile -ExecutionPolicy Bypass -Command "& .\scripts\smoke-windows.ps1 -Exe '<exe>' -ExeArgs @('-emuSmokeFault','crash')"
#
# Sound (AGENTS.md rule 4): nothing here touches the system volume, mute or volume mixer, and a Unity player has no
# command-line switch that mutes it (UnityPlayer.dll names "disableaudio", but -disableaudio did not stop the audio
# clock in a 6000.6 player), so the build itself must be silent. The run goes ahead when the build log next to the exe
# (<name>.build.log from build-unity.ps1, at least as new as the exe) has the "EMU_BUILD_NOTE audio-off:" line that
# EmuProjectBuild.BuildWindows / the sample's EmuBuild.BuildWindows print. Otherwise it stops before starting the
# player; -AllowAudio runs it anyway, only after the person agreed that the game may play sound.
# Tap: none by default. -Tap clicks with the real mouse (SendInput): it raises the player window, takes the focus from
# whatever the person is doing and moves the cursor for a moment (it is put back). It clicks only when the player
# window is the window under that point.
# PlayerPrefs: a Windows player keeps them in HKCU\Software\<company>\<product> (names from <name>_Data\app.info), and
# every start writes there (Unity stores the window size). By default the key is left as it is and only reported.
# -CleanPrefs: export that one key to the run folder (prefs-before.reg) and delete it before the start, so the run starts
# from a clean state; export (prefs-after.reg) and delete it again at the end. No other key is touched. To undo:
# reg import <file>.
param(
    [Parameter(Mandatory)] [string]$Exe,
    [string]$ReadyMarker = 'SMOKE_APP_READY',
    [int]$ReadyTimeoutSec = 120,
    [switch]$Tap,                    # click once (or up to 3 times until -TapMarker shows) with the real mouse
    [double]$TapX = 0.5,             # fraction of the player window's client area
    [double]$TapY = 0.5,
    [string]$TapMarker = 'SMOKE_TAP count=1',   # plain text the game logs when the click lands
    [switch]$NoTapCheck,             # click, but do not wait for -TapMarker
    [int]$Width = 1280,              # windowed player size (-screen-width / -screen-height)
    [int]$Height = 720,
    [int]$SettleSec = 3,             # final wait (crashes, dialogs and exceptions still watched) before 03-final.png
    [switch]$CleanPrefs,
    [switch]$AllowAudio,
    [switch]$FailOnException,        # a managed exception in Player.log fails the run (default: counted and reported)
    [string[]]$ExeArgs = @()         # more player arguments (an array: only with powershell -Command)
)
. "$PSScriptRoot\common.ps1"

foreach ($k in 'TapX', 'TapY', 'TapMarker', 'NoTapCheck') {
    if ($PSBoundParameters.ContainsKey($k) -and -not $Tap) { throw "-$k needs -Tap: the Windows smoke test clicks only with -Tap." }
}
Assert-PathArg 'Exe' $Exe
$Exe = (Resolve-Path -LiteralPath $Exe).ProviderPath
if ([IO.Path]::GetExtension($Exe) -ne '.exe') { throw "-Exe must be the player .exe: $Exe" }
if ([Diagnostics.Process]::GetCurrentProcess().SessionId -eq 0) {
    throw 'This shell runs in session 0 (a service or a scheduled task without a desktop): a player window cannot open here. Run it from a signed-in desktop session.'
}

if (-not ('EmuLabWin' -as [type])) {
    Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class EmuLabWin
{
    public class WinInfo { public IntPtr Handle; public string ClassName; public string Title; }
    delegate bool EnumProc(IntPtr hwnd, IntPtr lParam);
    [StructLayout(LayoutKind.Sequential)] struct RECT { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] struct POINT { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public MOUSEINPUT mi; }

    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
    [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, EnumProc cb, IntPtr lParam);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder sb, int max);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder sb, int max);
    [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr hwnd, out RECT rc);
    [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr hwnd, ref POINT p);
    [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT p);
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
    [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
    [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint count, INPUT[] inputs, int size);
    [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hwnd, int cmd);
    [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);

    // Physical pixels for this thread (Unity players are per-monitor DPI aware); a no-op before Windows 10 1607.
    static IntPtr EnterDpi()
    {
        try { return SetThreadDpiAwarenessContext(new IntPtr(-4)); } catch (EntryPointNotFoundException) { return IntPtr.Zero; }
    }
    static void LeaveDpi(IntPtr old)
    {
        if (old == IntPtr.Zero) return;
        try { SetThreadDpiAwarenessContext(old); } catch (EntryPointNotFoundException) { }
    }

    public static string ClassOf(IntPtr hwnd) { var sb = new StringBuilder(256); GetClassName(hwnd, sb, sb.Capacity); return sb.ToString(); }
    public static string TextOf(IntPtr hwnd) { var sb = new StringBuilder(1024); GetWindowText(hwnd, sb, sb.Capacity); return sb.ToString(); }

    // Visible top-level windows of a process.
    public static WinInfo[] TopWindows(int pid)
    {
        var list = new List<WinInfo>();
        EnumWindows(delegate(IntPtr h, IntPtr l) {
            uint owner;
            GetWindowThreadProcessId(h, out owner);
            if (owner == (uint)pid && IsWindowVisible(h)) list.Add(new WinInfo { Handle = h, ClassName = ClassOf(h), Title = TextOf(h) });
            return true;
        }, IntPtr.Zero);
        return list.ToArray();
    }

    // The text of a message box (#32770): its Static children.
    public static string DialogText(IntPtr hwnd)
    {
        var sb = new StringBuilder();
        EnumChildWindows(hwnd, delegate(IntPtr h, IntPtr l) {
            if (ClassOf(h) == "Static") { string t = TextOf(h).Trim(); if (t.Length > 0) { if (sb.Length > 0) sb.Append(" | "); sb.Append(t); } }
            return true;
        }, IntPtr.Zero);
        return sb.ToString();
    }

    // PNG of the window's client area. PrintWindow(PW_CLIENTONLY | PW_RENDERFULLCONTENT) also reads a covered window.
    // A screen copy is used only when PrintWindow fails and the window is in front: a covered window's screen area
    // shows other windows, which must not end up in the results.
    public static string Capture(IntPtr hwnd, string path)
    {
        IntPtr old = EnterDpi();
        try
        {
            if (IsIconic(hwnd)) return "failed: the window is minimized";
            RECT rc;
            if (!GetClientRect(hwnd, out rc)) return "failed: no client area";
            int w = rc.Right - rc.Left, h = rc.Bottom - rc.Top;
            if (w <= 0 || h <= 0) return "failed: empty client area";
            using (var bmp = new Bitmap(w, h, PixelFormat.Format24bppRgb))
            {
                bool ok;
                using (var g = Graphics.FromImage(bmp))
                {
                    IntPtr hdc = g.GetHdc();
                    try { ok = PrintWindow(hwnd, hdc, 3); } finally { g.ReleaseHdc(hdc); }
                }
                string how = "PrintWindow";
                if (!ok)
                {
                    if (GetForegroundWindow() != hwnd) return "failed: PrintWindow failed and the window is not in front";
                    POINT p = new POINT();
                    ClientToScreen(hwnd, ref p);
                    using (var g = Graphics.FromImage(bmp)) g.CopyFromScreen(p.X, p.Y, 0, 0, new Size(w, h));
                    how = "screen copy";
                }
                if (OneColor(bmp)) how += ", one color";
                bmp.Save(path, ImageFormat.Png);
                return "ok " + how + " " + w + "x" + h;
            }
        }
        finally { LeaveDpi(old); }
    }

    static bool OneColor(Bitmap b)
    {
        Color first = b.GetPixel(0, 0);
        for (int i = 0; i < 16; i++)
            for (int j = 0; j < 16; j++)
                if (b.GetPixel(b.Width * i / 16, b.Height * j / 16) != first) return false;
        return true;
    }

    static INPUT Mouse(uint flags)
    {
        var input = new INPUT();
        input.type = 0; // INPUT_MOUSE
        input.mi.dwFlags = flags;
        return input;
    }

    // Left click at a fraction of the client area with the real mouse. Restores and raises the window first, clicks only
    // when the point is inside its client area on a screen, the cursor really is there and the player window is the one
    // under it, and puts the cursor back. Anything else returns "not clicked: ..." without pressing the button.
    public static string Click(IntPtr hwnd, double fx, double fy)
    {
        IntPtr old = EnterDpi();
        try
        {
            if (fx < 0 || fx > 1 || fy < 0 || fy > 1) return "not clicked: -TapX/-TapY must be between 0 and 1";
            if (IsIconic(hwnd))
            {
                ShowWindow(hwnd, 9);   // SW_RESTORE
                Thread.Sleep(500);
                if (IsIconic(hwnd)) return "not clicked: the player window is minimized";
            }
            // Above every other normal window (TOPMOST, then back to NOTOPMOST), then try to take the focus.
            SetWindowPos(hwnd, new IntPtr(-1), 0, 0, 0, 0, 0x0043);
            SetWindowPos(hwnd, new IntPtr(-2), 0, 0, 0, 0, 0x0043);
            SetForegroundWindow(hwnd);
            Thread.Sleep(300);
            RECT rc;
            if (!GetClientRect(hwnd, out rc) || rc.Right <= 0 || rc.Bottom <= 0) return "not clicked: no client area";
            POINT origin = new POINT();
            ClientToScreen(hwnd, ref origin);
            POINT p = new POINT();
            p.X = origin.X + Math.Min(rc.Right - 1, (int)(rc.Right * fx));
            p.Y = origin.Y + Math.Min(rc.Bottom - 1, (int)(rc.Bottom * fy));
            int vx = GetSystemMetrics(76), vy = GetSystemMetrics(77), vw = GetSystemMetrics(78), vh = GetSystemMetrics(79);
            if (p.X < vx || p.Y < vy || p.X >= vx + vw || p.Y >= vy + vh)
                return "not clicked: " + p.X + "," + p.Y + " is off the screen (window moved off-screen?)";
            IntPtr at = WindowFromPoint(p);
            IntPtr root = at == IntPtr.Zero ? IntPtr.Zero : GetAncestor(at, 2);
            if (root != hwnd)
                return "not clicked: another window (" + (root == IntPtr.Zero ? "none" : ClassOf(root)) + ") is under " + p.X + "," + p.Y;
            POINT saved;
            GetCursorPos(out saved);
            SetCursorPos(p.X, p.Y);
            Thread.Sleep(50);
            POINT now;
            GetCursorPos(out now);
            at = WindowFromPoint(now);
            root = at == IntPtr.Zero ? IntPtr.Zero : GetAncestor(at, 2);
            if (now.X != p.X || now.Y != p.Y || root != hwnd)
            {
                SetCursorPos(saved.X, saved.Y);
                return "not clicked: the cursor did not land on the player window at " + p.X + "," + p.Y;
            }
            int size = Marshal.SizeOf(typeof(INPUT));
            uint sent = SendInput(1, new INPUT[] { Mouse(0x0002) }, size);   // MOUSEEVENTF_LEFTDOWN
            int error = Marshal.GetLastWin32Error();
            Thread.Sleep(80);
            sent += SendInput(1, new INPUT[] { Mouse(0x0004) }, size);       // MOUSEEVENTF_LEFTUP
            Thread.Sleep(100);
            SetCursorPos(saved.X, saved.Y);
            if (sent != 2) return "not clicked: SendInput sent " + sent + " of 2 events (error " + error + "; a locked desktop or an elevated window in front blocks input)";
            return "ok " + p.X + "," + p.Y;
        }
        finally { LeaveDpi(old); }
    }
}
'@
}

$run = New-RunDir 'windows'
$logPath = Join-Path $run 'Player.log'
$checks = [ordered]@{ exe = $Exe }
# Unity's native crash report in Player.log; managed exceptions are lines that start with the exception type.
$crashRegex = '(?m)^(Crash!!!|=+ OUTPUTTING STACK TRACE =+)'
$exceptionRegex = '(?m)^(?:[A-Za-z_]\w*\.)*[A-Za-z_]\w*Exception(?::[^\r\n]*)?\r?$'

function Read-PlayerLog {
    if (-not (Test-Path -LiteralPath $logPath)) { return '' }
    $fs = [IO.File]::Open($logPath, 'Open', 'Read', 'ReadWrite, Delete')
    try { return (New-Object IO.StreamReader($fs)).ReadToEnd() } finally { $fs.Dispose() }
}

function Get-PlayerWindow {
    # The Unity window (class UnityWndClass), else any visible window of the player (such as an error message box).
    if (-not $script:proc -or $script:proc.HasExited) { return $null }
    $wins = @([EmuLabWin]::TopWindows($script:proc.Id))
    $main = @($wins | Where-Object { $_.ClassName -eq 'UnityWndClass' }) | Select-Object -First 1
    if ($main) { return $main }
    return $wins | Select-Object -First 1
}

function Find-PlayerDialog {
    # A message box of the player (#32770), e.g. "Data folder not found" or "Failed to load mono". Recorded once.
    if ($script:dialog -or -not $script:proc -or $script:proc.HasExited) { return $script:dialog }
    $box = @([EmuLabWin]::TopWindows($script:proc.Id) | Where-Object { $_.ClassName -eq '#32770' }) | Select-Object -First 1
    if ($box) {
        $script:dialog = "$($box.Title): $([EmuLabWin]::DialogText($box.Handle))"
        Save-Shot '00-dialog.png' $box
    }
    return $script:dialog
}

function Save-Shot([string]$Name, $Window) {
    # A screenshot failure must not hide the real result.
    if (-not $Window) { $Window = Get-PlayerWindow }
    if (-not $Window) { $checks["screenshot_$Name"] = 'no player window'; return }
    try {
        $r = [EmuLabWin]::Capture($Window.Handle, (Join-Path $run $Name))
        if ($r -notlike 'ok *') { $checks["screenshot_$Name"] = $r }
        else { $checks.screenshots = (@($checks.screenshots | Where-Object { $_ }) + "$Name $($r.Substring(3))") }
    } catch { $checks["screenshot_$Name"] = $_.Exception.Message }
}

function Get-StopReason {
    # Why the run cannot pass any more, or $null: native crash, an error dialog, the player gone, or (only with
    # -FailOnException) a managed exception.
    $text = Read-PlayerLog
    if ($text -match $crashRegex) { return 'crash' }
    if (Find-PlayerDialog) { return 'dialog' }
    if ($script:proc.HasExited) { return 'exited' }
    if ($FailOnException -and $text -match $exceptionRegex) { return 'exception' }
    return $null
}

function Wait-Log([string]$Marker, [int]$TimeoutSec) {
    # @{ ok; stop } : ok = the marker is in Player.log; stop = Get-StopReason when it ended the wait early.
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    do {
        if ((Read-PlayerLog).Contains($Marker)) { return @{ ok = $true } }
        $stop = Get-StopReason
        if ($stop) { return @{ ok = $false; stop = $stop } }
        Start-Sleep -Milliseconds 500
    } while ((Get-Date) -lt $deadline)
    return @{ ok = (Read-PlayerLog).Contains($Marker) }
}

function Wait-Quiet([int]$Seconds) {
    # Wait while watching for a crash, a dialog or the player quitting. Returns the stop reason or $null.
    $deadline = (Get-Date).AddSeconds($Seconds)
    while ((Get-Date) -lt $deadline) {
        $stop = Get-StopReason
        if ($stop) { return $stop }
        Start-Sleep -Milliseconds 500
    }
    return Get-StopReason
}

function Get-RegistryPrefsKey { "Software\$($script:company)\$($script:product)" }

function Export-Prefs([string]$File) {
    # reg.exe writes the key with its values as a .reg file (UTF-16); "reg import <file>" puts it back.
    $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    try { $out = (& reg.exe export "HKCU\$(Get-RegistryPrefsKey)" $File /y 2>&1 | ForEach-Object { "$_" }) -join ' ' }
    finally { $ErrorActionPreference = $eap }
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $File)) { throw "reg export of HKCU\$(Get-RegistryPrefsKey) failed: $out" }
}

function Clear-Prefs([string]$BackupName) {
    # Back up, then delete, only HKCU\Software\<company>\<product>. Returns the backup path, or $null when there was no key.
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey((Get-RegistryPrefsKey))
    if (-not $key) { return $null }
    $key.Close()
    $file = Join-Path $run $BackupName
    Export-Prefs $file
    [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree((Get-RegistryPrefsKey), $false)
    return $file
}

$script:proc = $null; $script:dialog = $null; $script:company = $null; $script:product = $null
$watchdog = $null; $started = $null; $stoppedByUs = $false; $namesOk = $false; $exitedBySelf = $false
$crashRoot = $null; $crashBefore = @()
try {
    # --- Before the start: data folder, names, sound, a second copy of the same exe
    $dataDir = Get-WindowsDataDir $Exe
    $checks.data_dir = Test-Path -LiteralPath $dataDir -PathType Container
    if (-not $checks.data_dir) {
        throw "No $([IO.Path]::GetFileName($dataDir)) folder next to $([IO.Path]::GetFileName($Exe)): the player cannot start without it. Copy the whole build folder, not only the exe."
    }
    $info = [IO.Path]::Combine($dataDir, 'app.info')
    if (Test-Path -LiteralPath $info) {
        $lines = @([IO.File]::ReadAllLines($info, [Text.Encoding]::UTF8))
        if ($lines.Count -ge 2) { $script:company = $lines[0].Trim(); $script:product = $lines[1].Trim() }
    }
    $checks.company = $script:company
    $checks.product = $script:product
    $namesOk = $script:company -and $script:product -and ("$($script:company)$($script:product)" -notmatch '[\\/]')
    if ($namesOk) {
        $checks.prefs_key = "HKCU\$(Get-RegistryPrefsKey)"
        $k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey((Get-RegistryPrefsKey))
        $checks.prefs_existed = [bool]$k
        if ($k) { $k.Close() }
        $crashRoot = [IO.Path]::Combine([IO.Path]::GetTempPath(), $script:company, $script:product, 'Crashes')
        if ([IO.Directory]::Exists($crashRoot)) { $crashBefore = @([IO.Directory]::GetDirectories($crashRoot)) }
    } elseif ($CleanPrefs) {
        throw "-CleanPrefs: company/product from $info are missing or contain a slash ('$($script:company)', '$($script:product)'), so the PlayerPrefs key is not certain. Nothing was deleted."
    }

    $buildLog = [IO.Path]::ChangeExtension($Exe, '.build.log')
    $note = $false
    if (Test-Path -LiteralPath $buildLog -PathType Leaf) {
        # Only a log at least as new as the exe belongs to it (an Editor rebuild afterwards leaves an older log).
        if ((Get-Item -LiteralPath $buildLog).LastWriteTimeUtc -ge (Get-Item -LiteralPath $Exe).LastWriteTimeUtc) {
            $note = [bool](Select-String -LiteralPath $buildLog -SimpleMatch 'EMU_BUILD_NOTE audio-off:' -List)
        }
    }
    if ($note) { $checks.audio = 'off (build: Disable Unity Audio)' }
    elseif ($AllowAudio) { $checks.audio = 'may play sound (-AllowAudio)'; Write-Host 'WARN this player may play sound: -AllowAudio was given.' }
    else {
        throw ("Cannot confirm that this build is silent: no 'EMU_BUILD_NOTE audio-off:' line in $buildLog (or that log is older " +
            'than the exe). The player would run on this desktop with sound. Build it with EmuProjectBuild.BuildWindows ' +
            '(templates/, turns on Disable Unity Audio for the test build), or ask the person whether it may play sound and only ' +
            'then pass -AllowAudio. Do not change the system volume or mute (AGENTS.md rule 4).')
    }

    $stem = [IO.Path]::GetFileNameWithoutExtension($Exe)
    $running = @(Get-Process -Name $stem -ErrorAction SilentlyContinue | Where-Object { $_.Path -and (Test-SamePath $_.Path $Exe) })
    if ($running) {
        throw ("$([IO.Path]::GetFileName($Exe)) is already running (PID $(($running | ForEach-Object Id) -join ', ')): another test, or the person " +
            'playing. A second copy can share its PlayerPrefs or refuse to start. Ask the person to close it; this script does not stop it.')
    }

    # Windows does not stop children when their parent dies: if this script is killed before its finally block, the
    # watchdog stops every process whose command line names the run folder (the player's -logFile does).
    $watchdog = Start-Watchdog $run

    if ($CleanPrefs) {
        $b = Clear-Prefs 'prefs-before.reg'
        $checks.prefs_before_backup = if ($b) { $b } else { 'none (no key)' }
    }

    # --- Start the player windowed, its log in the run folder. Start-Process without redirection (ShellExecute) gives
    # the player no handle of ours, and its Process object keeps the exit code readable.
    $argList = @('-logFile', (Format-QuotedArg $logPath), '-screen-fullscreen', '0', '-screen-width', "$Width", '-screen-height', "$Height")
    $argList += @($ExeArgs | ForEach-Object { if ($_ -eq '' -or $_ -match '[\s"]') { Format-QuotedArg $_ } else { $_ } })
    $checks.player_args = ($argList | Select-Object -Skip 2) -join ' '
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $script:proc = Start-Process -FilePath $Exe -ArgumentList $argList -WorkingDirectory ([IO.Path]::GetDirectoryName($Exe)) -PassThru
    [void]$script:proc.Handle   # keeps ExitCode readable and the PID ours until we are done
    try { $started = $script:proc.StartTime } catch { }
    $checks.pid = $script:proc.Id
    $checks.launch = $true

    $ready = Wait-Log $ReadyMarker $ReadyTimeoutSec
    $checks.ready = [bool]$ready.ok
    $checks.ready_sec = [math]::Round($sw.Elapsed.TotalSeconds, 1)
    # The marker comes from the first frame's Start(), before that frame is on screen: give it a moment.
    if ($ready.ok) { Start-Sleep -Seconds 1 }
    if (-not $script:dialog) { Save-Shot '01-ready.png' }
    if (-not $ready.ok) {
        $why = switch ($ready.stop) {
            'crash' { 'the player crashed' }
            'dialog' { "the player shows an error dialog ($($script:dialog))" }
            'exited' { 'the player exited' }
            'exception' { 'a managed exception was logged (-FailOnException)' }
            default {
                if (-not (Read-PlayerLog)) { "Player.log stayed empty (a build with 'Use Player Log' off writes no log; EmuProjectBuild turns it on for its build)" }
                else { "not within $ReadyTimeoutSec s (a build with 'Run In Background' off pauses while its window has no focus; EmuProjectBuild turns it on for its build)" }
            }
        }
        throw "Ready marker '$ReadyMarker' not seen in Player.log: $why."
    }

    # --- Optional click with the real mouse
    if ($Tap) {
        Start-Sleep -Seconds 1   # the first frames after start-up can drop input
        for ($attempt = 1; $attempt -le 3; $attempt++) {
            $w = Get-PlayerWindow
            if (-not $w) { throw 'No player window to click.' }
            $r = [EmuLabWin]::Click($w.Handle, $TapX, $TapY)
            $checks.tap_point = $r
            if ($r -notlike 'ok *') { $checks.tap = $false; break }
            if ($NoTapCheck) { break }
            $t = Wait-Log $TapMarker 5
            $checks.tap = [bool]$t.ok
            $checks.tap_attempts = $attempt
            if ($t.ok -or $t.stop) { break }
        }
        Save-Shot '02-after-tap.png'
        if ($checks.Contains('tap') -and -not $checks.tap -and $checks.tap_point -notlike 'ok *') { throw "Tap failed: $($checks.tap_point)" }
    }

    # --- Settle, watching for a crash, a dialog or the player quitting
    $stop = Wait-Quiet $SettleSec
    if ($stop -ne 'exited' -and $stop -ne 'crash') { Save-Shot '03-final.png' }
}
catch {
    $checks.error = $_.Exception.Message
}
finally {
    if ($script:proc) {
        # After "Crash!!!" the player is still alive while its crash handler writes the report; it then ends by itself.
        if (-not $script:proc.HasExited -and (Read-PlayerLog) -match $crashRegex) { [void]$script:proc.WaitForExit(20000) }
        if (-not $script:proc.HasExited) {
            $closed = $false
            if (-not $script:dialog) {
                # WM_CLOSE: the game quits normally (OnApplicationQuit, PlayerPrefs saved).
                try { if ($script:proc.CloseMainWindow()) { $closed = $script:proc.WaitForExit(10000) } } catch { }
            }
            if ($closed) { $checks.closed = 'window closed' }
            else { $stoppedByUs = $true; Stop-ProcessTree $script:proc.Id $started; $checks.closed = 'stopped' }
        } else {
            $exitedBySelf = $true
        }
        [void]$script:proc.WaitForExit(5000)
        if ($script:proc.HasExited) {
            $code = $script:proc.ExitCode
            $checks.exit_code = $code
            $checks.exit_code_hex = '0x{0:X8}' -f $code
        }
        # A crash handler (UnityCrashHandler64, a child of the player) may still be writing its report.
        $deadline = (Get-Date).AddSeconds(15)
        while ((Get-Date) -lt $deadline -and @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$($script:proc.Id)" -ErrorAction SilentlyContinue |
                Where-Object { $_.Name -like 'UnityCrashHandler*' -and (-not $started -or $_.CreationDate -ge $started) }).Count) {
            Start-Sleep -Milliseconds 500
        }
        Stop-ProcessTree $script:proc.Id $started   # anything the player left behind (its own children only)
    }
    if ($CleanPrefs -and $namesOk -and $script:proc) {
        try {
            $b = Clear-Prefs 'prefs-after.reg'
            $checks.prefs_after_backup = if ($b) { $b } else { 'none (no key)' }
        } catch { $checks.prefs_clean_error = $_.Exception.Message }
    }
    if ($namesOk) {
        $k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey((Get-RegistryPrefsKey))
        $checks.prefs_left = [bool]$k
        if ($k) { $k.Close() }
    }
    if ($watchdog) { Stop-ProcessTree $watchdog.Id }   # last, so a kill during cleanup is still covered
}

# --- Verdict
$text = Read-PlayerLog
$crashLine = [regex]::Match($text, $crashRegex)
$newCrashDirs = @()
if ($crashRoot -and [IO.Directory]::Exists($crashRoot)) {
    $newCrashDirs = @([IO.Directory]::GetDirectories($crashRoot) | Where-Object { $crashBefore -notcontains $_ })
}
# An NTSTATUS exit code (0xC0000005 access violation, ...) is negative as Int32; our own stop gives -1, not a crash.
$badExit = $checks.Contains('exit_code') -and $checks.exit_code -lt 0 -and -not $stoppedByUs
$checks.crash = $crashLine.Success -or $newCrashDirs.Count -gt 0 -or $badExit
# app_exited (as on Android): the player ended by itself without a crash.
if ($script:proc) { $checks.app_exited = $exitedBySelf -and -not $checks.crash }
if ($exitedBySelf -and $checks.crash) { $checks.closed = 'crashed' }
if ($crashLine.Success) { $checks.crash_log = $crashLine.Value.Trim() }
if ($newCrashDirs.Count) {
    $checks.crash_dirs = $newCrashDirs
    $err = [IO.Path]::Combine($newCrashDirs[0], 'error.log')
    if (Test-Path -LiteralPath $err) { Copy-Item -LiteralPath $err -Destination (Join-Path $run 'crash-error.log') -ErrorAction SilentlyContinue }
}
$exc = @([regex]::Matches($text, $exceptionRegex) | ForEach-Object { $_.Value.Trim() })
$checks.exceptions = $exc.Count
if ($exc.Count) { $checks.first_exception = $exc[0].Substring(0, [Math]::Min(300, $exc[0].Length)) }
if ($script:dialog) { $checks.dialog = $script:dialog }
if ($checks.app_exited -and -not $checks.crash -and -not $checks.error) {
    $checks.error = "The player exited by itself (exit code $($checks.exit_code)) with no crash in Player.log: Application.Quit, a failed start-up check (login, patch server, anti-cheat) or a fatal error it handled. See Player.log in $run."
}

$tapOk = (-not $Tap) -or $NoTapCheck -or $checks.tap
$pass = $checks.ready -and $tapOk -and -not $checks.crash -and -not $checks.app_exited -and -not $script:dialog -and
        -not $checks.error -and -not ($FailOnException -and $exc.Count)
$checks.pass = [bool]$pass
$checks.run_dir = $run
$checks | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $run 'summary.json') -Encoding UTF8
$checks.GetEnumerator() | ForEach-Object { Write-Host ("  {0,-20} {1}" -f $_.Key, (@($_.Value) -join '; ')) }
if ($checks.prefs_left) { Write-Host "PREFS_LEFT $($checks.prefs_key) (PlayerPrefs of this game on this PC; -CleanPrefs backs it up and deletes it)" }
Write-Host "WINDOWS_SMOKE $(if ($pass) { 'PASS' } else { 'FAIL' }) dir=$run"
exit $(if ($pass) { 0 } else { 1 })
