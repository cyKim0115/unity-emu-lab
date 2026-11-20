# Minimal Chrome DevTools Protocol client for Windows PowerShell 5.1 (no extra installs).
# Dot-source after common.ps1. Set $script:CdpOnEvent = { param($m) ... } to receive CDP events.
# Messages are parsed with JavaScriptSerializer (no 2 MB limit, unlike ConvertFrom-Json on PS 5.1),
# so results are dictionaries: $r['data'], $m['params']['args'].

Add-Type -AssemblyName System.Web.Extensions
$script:CdpJson = New-Object System.Web.Script.Serialization.JavaScriptSerializer
$script:CdpJson.MaxJsonLength = [int]::MaxValue
$script:CdpWs = $null
$script:CdpNextId = 0
$script:CdpPending = $null
$script:CdpBuffer = New-Object byte[] 1048576
$script:CdpStream = New-Object IO.MemoryStream
$script:CdpOnEvent = $null

function Find-Browser {
    $candidates = @(
        "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
        "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
        "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
        "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
        "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
    )
    return $candidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
}

# Ports Chrome/Edge refuse to load (net::ERR_UNSAFE_PORT) that a Windows ephemeral range can hand out.
$script:BrowserBlockedPorts = @(1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566,
    6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080)

function Get-FreePort {
    # Keep rejected ports bound while retrying so the next pick is a different port.
    $held = New-Object Collections.ArrayList
    try {
        for ($i = 0; $i -lt 50; $i++) {
            $l = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, 0)
            $l.Start(); $port = $l.LocalEndpoint.Port
            if ($script:BrowserBlockedPorts -notcontains $port) { $l.Stop(); return $port }
            [void]$held.Add($l)
        }
        throw 'No free port that the browser will load.'
    } finally {
        foreach ($h in $held) { $h.Stop() }
    }
}

function Connect-Cdp([int]$Port, [int]$TimeoutSec = 20) {
    # Attach to the first page target of a browser started with --remote-debugging-port.
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    $wsUrl = $null
    while (-not $wsUrl -and (Get-Date) -lt $deadline) {
        try {
            $targets = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/list" -TimeoutSec 2
            $wsUrl = ($targets | Where-Object { $_.type -eq 'page' } | Select-Object -First 1).webSocketDebuggerUrl
        } catch { }
        if (-not $wsUrl) { Start-Sleep -Milliseconds 500 }
    }
    if (-not $wsUrl) { throw "No DevTools page target on port $Port." }
    $ws = New-Object Net.WebSockets.ClientWebSocket
    try { $ws.ConnectAsync([Uri]$wsUrl, [Threading.CancellationToken]::None).Wait() }
    catch { throw "DevTools connect to $wsUrl failed: $($_.Exception.GetBaseException().Message)" }
    $script:CdpWs = $ws
    $script:CdpPending = $null
    $script:CdpStream.SetLength(0)
}

function Assert-CdpOpen {
    # Chrome drops the socket without a Close frame when it exits or crashes, so report that plainly instead of
    # Task.Wait's "One or more errors occurred."
    if (-not $script:CdpWs) { throw 'DevTools is not connected.' }
    if ($script:CdpWs.State -ne [Net.WebSockets.WebSocketState]::Open) {
        throw "DevTools connection lost (browser exited or crashed): socket state $($script:CdpWs.State)."
    }
}

function Receive-CdpMessage([int]$TimeoutMs) {
    # Returns one parsed message, or $null on timeout. An unfinished receive is kept for the next call.
    $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMs)
    while ($true) {
        if (-not $script:CdpPending) {
            Assert-CdpOpen
            $script:CdpPending = $script:CdpWs.ReceiveAsync([ArraySegment[byte]]::new($script:CdpBuffer), [Threading.CancellationToken]::None)
        }
        $left = [int][Math]::Max(0, ($deadline - [DateTime]::UtcNow).TotalMilliseconds)
        try { $done = $script:CdpPending.Wait($left) }
        catch {
            $script:CdpPending = $null; $script:CdpStream.SetLength(0)
            throw "DevTools connection lost (browser exited or crashed): $($_.Exception.GetBaseException().Message)"
        }
        if (-not $done) { return $null }
        $r = $script:CdpPending.Result
        $script:CdpPending = $null
        if ($r.MessageType -eq [Net.WebSockets.WebSocketMessageType]::Close) { throw 'DevTools connection closed.' }
        $script:CdpStream.Write($script:CdpBuffer, 0, $r.Count)
        if ($r.EndOfMessage) {
            $text = [Text.Encoding]::UTF8.GetString($script:CdpStream.ToArray())
            $script:CdpStream.SetLength(0)
            return $script:CdpJson.DeserializeObject($text)
        }
    }
}

function Send-Cdp([string]$Method, $Params = $null) {
    # Fire a command and return its id without waiting for the reply.
    $script:CdpNextId++
    $msg = @{ id = $script:CdpNextId; method = $Method }
    if ($Params) { $msg.params = $Params }
    $bytes = [Text.Encoding]::UTF8.GetBytes($script:CdpJson.Serialize($msg))
    Assert-CdpOpen
    try {
        $script:CdpWs.SendAsync([ArraySegment[byte]]::new($bytes), [Net.WebSockets.WebSocketMessageType]::Text, $true,
            [Threading.CancellationToken]::None).Wait()
    } catch { throw "DevTools connection lost (browser exited or crashed): $($_.Exception.GetBaseException().Message)" }
    return $script:CdpNextId
}

function Invoke-CdpEvent($Message) {
    if (-not $Message.ContainsKey('method')) { return }   # reply to a fire-and-forget command
    # alert()/confirm() block the page (and every later command such as screenshots): close them at once.
    # Only send here; waiting for the reply inside an event callback would swallow the caller's reply.
    if ($Message['method'] -eq 'Page.javascriptDialogOpening') {
        Send-Cdp 'Page.handleJavaScriptDialog' @{ accept = $true } | Out-Null
    }
    if ($script:CdpOnEvent) { & $script:CdpOnEvent $Message }
}

function Invoke-Cdp([string]$Method, $Params = $null, [int]$TimeoutSec = 30) {
    $id = Send-Cdp $Method $Params
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        $m = Receive-CdpMessage 1000
        if (-not $m) { continue }
        if ($m.ContainsKey('id') -and $m['id'] -eq $id) {
            if ($m.ContainsKey('error')) { throw "CDP $Method failed: $($m['error']['message'])" }
            return $m['result']
        }
        Invoke-CdpEvent $m
    }
    throw "CDP $Method timed out after $TimeoutSec s."
}

function Wait-CdpEvents([int]$TimeoutMs) {
    # Pump events for up to TimeoutMs.
    $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMs)
    while ([DateTime]::UtcNow -lt $deadline) {
        $m = Receive-CdpMessage ([int][Math]::Max(0, ($deadline - [DateTime]::UtcNow).TotalMilliseconds))
        if (-not $m) { break }
        Invoke-CdpEvent $m
    }
}

function Invoke-CdpEval([string]$Expression) {
    $r = Invoke-Cdp 'Runtime.evaluate' @{ expression = $Expression; returnByValue = $true; awaitPromise = $true }
    if ($r.ContainsKey('exceptionDetails')) { throw "evaluate failed: $($r['exceptionDetails']['text'])" }
    return $r['result']['value']
}

function Save-CdpScreenshot([string]$Path) {
    $r = Invoke-Cdp 'Page.captureScreenshot' @{ format = 'png' }
    [IO.File]::WriteAllBytes($Path, [Convert]::FromBase64String($r['data']))
}

function Invoke-CdpClick([double]$X, [double]$Y) {
    Invoke-Cdp 'Input.dispatchMouseEvent' @{ type = 'mouseMoved'; x = $X; y = $Y } | Out-Null
    Invoke-Cdp 'Input.dispatchMouseEvent' @{ type = 'mousePressed'; x = $X; y = $Y; button = 'left'; buttons = 1; clickCount = 1 } | Out-Null
    Start-Sleep -Milliseconds 80
    Invoke-Cdp 'Input.dispatchMouseEvent' @{ type = 'mouseReleased'; x = $X; y = $Y; button = 'left'; buttons = 0; clickCount = 1 } | Out-Null
}
