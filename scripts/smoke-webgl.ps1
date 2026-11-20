# Self-test a Unity WebGL build in a real browser, driven over the Chrome DevTools Protocol:
# serve the build locally -> open it in Chrome/Edge (throwaway profile, muted) -> wait for a console marker
# -> click a point on the canvas -> collect console errors, screenshots and a summary.
# Results: artifacts\<stamp>-webgl-<pid>\ (console.txt, server.log, PNG screenshots, summary.json).
# Exit 0 on PASS, 1 on FAIL. The throwaway browser profile is deleted afterwards unless -KeepProfile.
#
#   smoke-webgl.ps1 -BuildDir sample\EmuSmoke\Builds\WebGL
#   smoke-webgl.ps1 -BuildDir <dir> -ReadyMarker "<console line>" -NoTapCheck -Headless
#   smoke-webgl.ps1 -BuildDir <dir> -ReadyMode Loaded -NoTapCheck   # no marker: Unity template's loading bar hides
#   smoke-webgl.ps1 -BuildDir <dir> -ReadyMode Expression -ReadyExpression "window.session.stage === 'running'" `
#       -TapY 0.6 -TapExpression "window.session.stage !== 'running'" -TapRetrySec 5 -TapTimeoutSec 60 `
#       -AfterTapExpression "window.session.stage === 'play-ready'" -AfterTapTimeoutSec 120   # page-reported state
# -TapRetrySec taps again every N s until -TapExpression says the tap was accepted (a title screen often ignores
# input while its intro plays); -AfterTapExpression is then awaited once, without more taps.
# Expressions are JavaScript evaluated in the page (use single quotes inside them). -FailExpression returns a
# non-empty string when the page shows its own error UI; -InfoExpression is recorded in summary.json.
param(
    [Parameter(Mandatory)] [string]$BuildDir,
    [ValidateSet('Marker', 'Loaded', 'Expression')] [string]$ReadyMode = 'Marker',
    [string]$ReadyMarker = 'SMOKE_APP_READY',
    [string]$ReadyExpression,
    [int]$ReadyTimeoutSec = 180,
    [double]$TapX = 0.5,             # fraction of the canvas
    [double]$TapY = 0.5,
    [string]$TapMarker = 'SMOKE_TAP count=1',
    [string]$TapExpression,          # instead of -TapMarker: JS that is truthy once the tap took effect
    [int]$TapTimeoutSec = 5,
    [int]$TapRetrySec = 0,           # >0 with -TapExpression: tap again every N s until accepted (within -TapTimeoutSec)
    [string]$AfterTapExpression,     # awaited after an accepted tap (no more taps)
    [int]$AfterTapTimeoutSec = 120,
    [int]$SettleSec = 2,             # final wait (errors still collected) before 03-final.png and the summary
    [string]$FailExpression,
    [string]$InfoExpression,
    [switch]$NoTap,
    [switch]$NoTapCheck,
    [int]$Width = 1280,              # browser viewport (CSS px)
    [int]$Height = 900,
    [switch]$Headless,
    [string]$Browser,                # path to chrome.exe / msedge.exe; default: first one found
    [switch]$NoIsolation,            # serve without COOP/COEP (template loads cross-origin files without CORP/CORS)
    [switch]$KeepProfile             # keep <run>\browser-profile (HTTP + Unity caches, tens of MB) for debugging
)
. "$PSScriptRoot\common.ps1"
. "$PSScriptRoot\cdp.ps1"

Assert-PathArg 'BuildDir' $BuildDir
$BuildDir = Remove-TrailingSeparator (Resolve-Path -LiteralPath $BuildDir).ProviderPath
if (-not (Test-Path -LiteralPath (Join-Path $BuildDir 'index.html'))) { throw "No index.html in $BuildDir" }
if ($ReadyMode -eq 'Expression' -and -not $ReadyExpression) { throw '-ReadyMode Expression needs -ReadyExpression.' }
if (-not $Browser) { $Browser = Find-Browser }
if (-not $Browser) { throw 'Chrome or Edge not found; pass -Browser.' }

$run = New-RunDir 'webgl'
$consolePath = Join-Path $run 'console.txt'
$checks = [ordered]@{ build_dir = $BuildDir; browser = [IO.Path]::GetFileName($Browser) }
$utf8 = New-Object Text.UTF8Encoding $false
$console = New-Object Text.StringBuilder
$script:errors = New-Object Collections.ArrayList
$script:exceptions = 0
$script:targetCrashed = $false
# Console/log errors that mean the content did not run: Unity loader and wasm failures, missing build
# files, no WebGL context, and alert() dialogs (Unity's loader reports fatal errors with alert()).
$fatalRegex = (@(
    'abort\(', 'RuntimeError', 'Unable to parse', 'Failed to download', 'out of memory',
    'An error occurred running the Unity content', 'Uncaught', 'failed to asynchronously prepare wasm',
    'both async and sync fetching', 'status of [45]\d\d[^\n]*/Build/', 'WebGL context', 'WebGL is not supported',
    '^DIALOG ', '^BANNER ', '^PAGE_ERROR '
) -join '|')
function Test-Fatal { return [bool](@($script:errors | Where-Object { $_ -match $fatalRegex }).Count) }

function Test-PageExpr([string]$Expr) {
    # Truthy test of a page expression; errors in the expression count as false.
    try { return [bool](Invoke-CdpEval "(() => { try { return !!($Expr); } catch (e) { return false; } })()") } catch { return $false }
}

function Test-PageFail {
    # Records the page's own error UI (-FailExpression) once, as a fatal error.
    if (-not $FailExpression -or $script:pageFailSeen) { return }
    $text = try { Invoke-CdpEval "(() => { try { const v = ($FailExpression); return v ? String(v) : ''; } catch (e) { return ''; } })()" } catch { '' }
    if ($text) {
        $script:pageFailSeen = $true
        [void]$script:errors.Add("PAGE_ERROR $text")
        Write-ConsoleLine "$(Get-Date -Format 'HH:mm:ss.fff') [page-error] $text"
    }
}
$script:pageFailSeen = $false

function Test-Stop {
    # True once the run cannot pass any more: crash, uncaught exception or a fatal error (incl. page error UI).
    Test-PageFail
    return ($script:targetCrashed -or $script:exceptions -gt 0 -or (Test-Fatal))
}

function Wait-Expression([string]$Expr, [int]$TimeoutSec) {
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        if (Test-Stop) { return $false }
        if (Test-PageExpr $Expr) { return $true }
        Wait-CdpEvents 500
    }
    return (Test-PageExpr $Expr)
}

function Write-ConsoleLine([string]$Line) {
    [void]$console.AppendLine($Line)
    [IO.File]::AppendAllText($consolePath, $Line + "`r`n", $utf8)
}

$script:CdpOnEvent = {
    param($m)
    $p = $m['params']
    $stamp = Get-Date -Format 'HH:mm:ss.fff'
    switch ($m['method']) {
        'Runtime.consoleAPICalled' {
            $text = ($p['args'] | ForEach-Object {
                if ($_.ContainsKey('value')) { "$($_['value'])" } elseif ($_.ContainsKey('description')) { $_['description'] } else { $_['type'] }
            }) -join ' '
            Write-ConsoleLine "$stamp [$($p['type'])] $text"
            if ($p['type'] -eq 'error' -or $p['type'] -eq 'assert') { [void]$script:errors.Add($text) }
        }
        'Runtime.exceptionThrown' {
            $d = $p['exceptionDetails']
            $text = if ($d.ContainsKey('exception') -and $d['exception'].ContainsKey('description')) { $d['exception']['description'] } else { $d['text'] }
            $script:exceptions++
            [void]$script:errors.Add("EXCEPTION $text")
            Write-ConsoleLine "$stamp [exception] $text"
        }
        'Log.entryAdded' {
            $e = $p['entry']
            if ($e['level'] -eq 'error' -and "$($e['url'])" -notmatch 'favicon\.ico') {
                [void]$script:errors.Add("$($e['text']) $($e['url'])")
                Write-ConsoleLine "$stamp [log-error] $($e['text']) $($e['url'])"
            }
        }
        'Inspector.targetCrashed' { $script:targetCrashed = $true; Write-ConsoleLine "$stamp [crash] renderer crashed" }
        'Page.javascriptDialogOpening' {
            [void]$script:errors.Add("DIALOG $($p['type']): $($p['message'])")
            Write-ConsoleLine "$stamp [dialog-$($p['type'])] $($p['message'])"
        }
    }
}

function Wait-Console([string]$Marker, [int]$TimeoutSec) {
    # Stops early on a crash, an uncaught exception or a fatal console error.
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        if ($console.ToString().Contains($Marker)) { return $true }
        if (Test-Stop) { return $false }
        Wait-CdpEvents 500
    }
    return $console.ToString().Contains($Marker)
}

function Wait-Loaded([int]$TimeoutSec) {
    # For builds without a ready log: the Default template hides the loading bar (Unity 6.6 hides its
    # #unity-loading-container parent) when loading reaches 100%. "Hidden" = the bar has no rendered boxes,
    # which also covers a hidden ancestor. The 6.6 CSS also hides it before the first progress callback,
    # so "hidden" counts as loaded only after the page has fetched the build's .wasm or .data file
    # ('idle' = hidden but nothing fetched, e.g. a template that waits for a click before loading).
    # Then watch a few more seconds for start-up errors.
    $probe = "(() => { const b = document.querySelector('#unity-loading-bar'); if (!b) return 'nobar'; if (b.getClientRects().length !== 0) return 'loading'; const f = performance.getEntriesByType('resource').some(e => /\.(wasm|data)(\.(br|gz|unityweb))?([?#]|$)/i.test(e.name)); return f ? 'loaded' : 'idle'; })()"
    $start = Get-Date
    $deadline = $start.AddSeconds($TimeoutSec)
    $sawBar = $false
    while ((Get-Date) -lt $deadline) {
        if (Test-Stop) { return $false }
        $state = try { Invoke-CdpEval $probe } catch { 'loading' }
        if ($state -ne 'nobar') { $sawBar = $true }
        if ($state -eq 'loaded') {
            Wait-CdpEvents 3000
            return -not (Test-Stop)
        }
        $elapsed = ((Get-Date) - $start).TotalSeconds
        if ($state -eq 'idle' -and $elapsed -gt 15) {
            throw 'Unity loader never fetched the build (.wasm/.data): the template may wait for a click. Use -ReadyMode Marker.'
        }
        if ($state -eq 'nobar' -and -not $sawBar -and $elapsed -gt 10) {
            throw 'No #unity-loading-bar in this template; use -ReadyMode Marker with -ReadyMarker.'
        }
        Wait-CdpEvents 500
    }
    return $false
}

function Save-Shot([string]$Name) {
    # A screenshot failure must not hide the real result.
    try { Save-CdpScreenshot (Join-Path $run $Name) } catch { $checks["screenshot_$Name"] = $_.Exception.Message }
}

$server = $null; $browserProc = $null; $profileDir = $null; $watchdog = $null
try {
    # Watchdog first: if this script is killed before its finally block runs, it stops the server and browser.
    $watchdog = Start-Watchdog $run

    # Local server for the build
    $port = Get-FreePort
    $serveArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
        (Join-Path $PSScriptRoot 'serve-static.ps1'), '-Root', $BuildDir, '-Port', "$port")
    if ($NoIsolation) { $serveArgs += '-NoIsolation' }
    $server = Start-Detached 'powershell.exe' $serveArgs (Join-Path $run 'server.log') $null
    $url = "http://localhost:$port/index.html"
    $deadline = (Get-Date).AddSeconds(20)
    do {
        Start-Sleep -Milliseconds 500
        try { $ok = (Invoke-WebRequest -Uri $url -UseBasicParsing -Method Head -TimeoutSec 2).StatusCode -eq 200 } catch { $ok = $false }
    } while (-not $ok -and (Get-Date) -lt $deadline)
    $checks.server = $ok
    if (-not $ok) { throw "Static server did not start on port $port." }

    # Browser with its own throwaway profile (never the user's), muted, DevTools on a free port
    $cdpPort = Get-FreePort
    $profileDir = Join-Path $run 'browser-profile'
    $browserArgs = @("--user-data-dir=`"$profileDir`"", "--remote-debugging-port=$cdpPort", '--no-first-run',
        '--no-default-browser-check', '--mute-audio', '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
        "--window-size=$Width,$Height", 'about:blank')
    if ($Headless) { $browserArgs = @('--headless=new') + $browserArgs }
    $browserProc = Start-Process -FilePath $Browser -ArgumentList $browserArgs -PassThru
    $browserStarted = $null; try { $browserStarted = $browserProc.StartTime } catch { }   # for Stop-ProcessTree after the main process exits
    Connect-Cdp $cdpPort

    Invoke-Cdp 'Runtime.enable' | Out-Null
    Invoke-Cdp 'Log.enable' | Out-Null
    Invoke-Cdp 'Page.enable' | Out-Null
    Invoke-Cdp 'Inspector.enable' | Out-Null
    Invoke-Cdp 'Emulation.setDeviceMetricsOverride' @{ width = $Width; height = $Height; deviceScaleFactor = 1; mobile = $false } | Out-Null
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $nav = Invoke-Cdp 'Page.navigate' @{ url = $url }
    # The browser reports a failed load here (unsafe port, refused connection), not on the console.
    if ($nav -and $nav.ContainsKey('errorText') -and $nav['errorText']) { throw "Could not open ${url}: $($nav['errorText'])" }

    $checks.ready_mode = $ReadyMode
    $checks.ready = switch ($ReadyMode) {
        'Loaded' { Wait-Loaded $ReadyTimeoutSec }
        'Expression' { Wait-Expression $ReadyExpression $ReadyTimeoutSec }
        default { Wait-Console $ReadyMarker $ReadyTimeoutSec }
    }
    $checks.ready_sec = [math]::Round($sw.Elapsed.TotalSeconds, 1)
    Save-Shot '01-ready.png'
    if (-not $checks.ready) {
        throw $(switch ($ReadyMode) {
            'Loaded' { 'Unity content did not finish loading.' }
            'Expression' { "Ready expression never became true: $ReadyExpression" }
            default { "Ready marker '$ReadyMarker' not seen in the console." }
        })
    }

    if (-not $NoTap) {
        $rect = Invoke-CdpEval "(() => { const c = document.querySelector('#unity-canvas') || document.querySelector('canvas'); if (!c) return null; const r = c.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()"
        if (-not $rect) { throw 'No canvas element found.' }
        $x = [math]::Round($rect['x'] + $rect['w'] * $TapX, 1); $y = [math]::Round($rect['y'] + $rect['h'] * $TapY, 1)
        $checks.tap_point = "$x,$y in canvas $([int]$rect['w'])x$([int]$rect['h'])"
        Wait-CdpEvents 1000
        if ($TapExpression -and $TapRetrySec -gt 0 -and -not $NoTapCheck) {
            # Tap, give it TapRetrySec to take effect, tap again; stop once accepted or after TapTimeoutSec.
            $tapDeadline = (Get-Date).AddSeconds($TapTimeoutSec)
            $attempt = 0
            do {
                $attempt++
                Invoke-CdpClick $x $y
                $left = [int][Math]::Max(1, [Math]::Min($TapRetrySec, ($tapDeadline - (Get-Date)).TotalSeconds))
                $checks.tap = Wait-Expression $TapExpression $left
            } while (-not $checks.tap -and (Get-Date) -lt $tapDeadline -and -not (Test-Stop))
            $checks.tap_attempts = $attempt
        } else {
            for ($attempt = 1; $attempt -le 3; $attempt++) {
                Invoke-CdpClick $x $y
                if ($NoTapCheck) { break }
                $checks.tap = if ($TapExpression) { Wait-Expression $TapExpression $TapTimeoutSec } else { Wait-Console $TapMarker $TapTimeoutSec }
                $checks.tap_attempts = $attempt
                if ($checks.tap -or (Test-Stop)) { break }
            }
        }
        $checks.tap_sec = [math]::Round($sw.Elapsed.TotalSeconds, 1)
        if ($AfterTapExpression -and ($checks.tap -or $NoTapCheck)) {
            $checks.after_tap = Wait-Expression $AfterTapExpression $AfterTapTimeoutSec
            $checks.after_tap_sec = [math]::Round($sw.Elapsed.TotalSeconds, 1)
        }
        Wait-CdpEvents 500
        Save-Shot '02-after-tap.png'
    }

    # Settle, then read the Unity template's error banner (shown for load/runtime errors).
    Wait-CdpEvents ($SettleSec * 1000)
    Save-Shot '03-final.png'
    Test-PageFail
    $banner = Invoke-CdpEval "(() => { const w = document.querySelector('#unity-warning'); return w ? w.innerText.trim() : ''; })()"
    if ($banner) { $checks.unity_banner = $banner; [void]$script:errors.Add("BANNER $banner") }
    if ($InfoExpression) {
        $checks.page_info = try { "$(Invoke-CdpEval "(() => { try { const v = ($InfoExpression); return typeof v === 'string' ? v : JSON.stringify(v); } catch (e) { return 'error: ' + e.message; } })()")" } catch { $_.Exception.Message }
    }
}
catch {
    $checks.error = $_.Exception.Message
}
finally {
    if ($script:CdpWs) { try { Invoke-Cdp 'Browser.close' -TimeoutSec 5 | Out-Null } catch { } }
    if ($browserProc) { Start-Sleep -Seconds 1; Stop-ProcessTree $browserProc.Id $browserStarted }
    if ($server) { Stop-ProcessTree $server.Id }
    # The throwaway profile holds the build's HTTP and Unity caches (tens of MB per run); results do not need it.
    # Retry while the browser's last processes release their file handles.
    if ($profileDir -and -not $KeepProfile) {
        for ($i = 0; $i -lt 20 -and (Test-Path -LiteralPath $profileDir); $i++) {
            if ($i) { Start-Sleep -Milliseconds 500 }
            Remove-Item -LiteralPath $profileDir -Recurse -Force -ErrorAction SilentlyContinue
        }
        if (Test-Path -LiteralPath $profileDir) { $checks.profile_left = $profileDir }
    }
    if ($watchdog) { Stop-ProcessTree $watchdog.Id }   # last, so a kill during cleanup is still covered
}

$fatal = @($script:errors | Where-Object { $_ -match $fatalRegex })
$checks.console_errors = $script:errors.Count
$checks.fatal_errors = $fatal.Count
$checks.exceptions = $script:exceptions
$checks.crash = $script:targetCrashed
if ($fatal) { $checks.first_fatal = "$($fatal[0])".Substring(0, [Math]::Min(300, "$($fatal[0])".Length)) }
$pass = $checks.ready -and ($NoTap -or $NoTapCheck -or $checks.tap) -and
        ($NoTap -or -not $AfterTapExpression -or $checks.after_tap) -and -not $fatal -and
        -not $script:targetCrashed -and $script:exceptions -eq 0 -and -not $checks.error
$checks.pass = [bool]$pass
$checks.run_dir = $run
$checks | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $run 'summary.json') -Encoding UTF8
$checks.GetEnumerator() | ForEach-Object { Write-Host ("  {0,-18} {1}" -f $_.Key, $_.Value) }
Write-Host "WEBGL_SMOKE $(if ($pass) { 'PASS' } else { 'FAIL' }) dir=$run"
exit $(if ($pass) { 0 } else { 1 })
