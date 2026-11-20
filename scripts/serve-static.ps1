# Minimal static file server for Unity WebGL builds (no admin rights, no Python/Node).
# - Unity build files (*.data|js|wasm|symbols.json + .br/.gz) go out with Content-Encoding and the inner file's
#   Content-Type, as Unity's loader expects; any other .br/.gz (e.g. StreamingAssets the game unpacks itself)
#   is sent as the raw compressed bytes.
# - COOP/COEP/CORP headers like Unity's own Build And Run server, so multithreaded builds get SharedArrayBuffer
#   (-NoIsolation turns them off for templates that load cross-origin resources without CORP/CORS).
# - Requests run concurrently and plain files answer single byte ranges: a <video> element (VideoPlayer with a
#   StreamingAssets URL) stops reading once it has enough data, and a one-at-a-time server would then hold
#   every later request.
#
#   serve-static.ps1 -Root sample\EmuSmoke\Builds\WebGL -Port 8765
param(
    [Parameter(Mandatory)] [string]$Root,
    [int]$Port = 8765,
    [switch]$NoIsolation
)
$ErrorActionPreference = 'Stop'
# -LiteralPath: a folder like 'My Game [v2]' is not a wildcard (plain Resolve-Path returns nothing for it).
$Root = (Resolve-Path -LiteralPath $Root).ProviderPath.TrimEnd('\') + '\'

$types = @{
    '.html' = 'text/html; charset=utf-8'; '.js' = 'application/javascript'; '.wasm' = 'application/wasm'
    '.json' = 'application/json'; '.css' = 'text/css'; '.png' = 'image/png'; '.jpg' = 'image/jpeg'
    '.ico' = 'image/x-icon'; '.svg' = 'image/svg+xml'; '.txt' = 'text/plain'; '.data' = 'application/octet-stream'
    '.mp4' = 'video/mp4'; '.webm' = 'video/webm'; '.gz' = 'application/gzip'
}

# One request, run on a pool thread. Logs go straight to stdout (Write-Host in a pool runspace goes nowhere).
$handler = {
    param($ctx, [string]$Root, [hashtable]$types, [bool]$isolate)
    $ErrorActionPreference = 'Stop'
    $req = $ctx.Request; $res = $ctx.Response
    $status = 200; $note = ''; $started = $false; $fs = $null
    try {
        $rel = [Uri]::UnescapeDataString($req.Url.AbsolutePath.TrimStart('/'))
        if (-not $rel -or $rel.EndsWith('/')) { $rel += 'index.html' }
        $path = [IO.Path]::GetFullPath([IO.Path]::Combine($Root, $rel.Replace('/', '\')))
        if (-not $path.StartsWith($Root, [StringComparison]::OrdinalIgnoreCase) -or -not [IO.File]::Exists($path)) {
            $status = 404
        } else {
            $ext = [IO.Path]::GetExtension($path).ToLowerInvariant()
            $encoding = $null
            if ($path -match '\.(data|js|wasm|symbols\.json)\.(br|gz)$') { $encoding = @{ '.br' = 'br'; '.gz' = 'gzip' }[$ext] }
            if ($encoding) {
                $res.AddHeader('Content-Encoding', $encoding)
                $ext = [IO.Path]::GetExtension([IO.Path]::GetFileNameWithoutExtension($path)).ToLowerInvariant()
            }
            $res.ContentType = if ($types.ContainsKey($ext)) { $types[$ext] } else { 'application/octet-stream' }
            $res.AddHeader('Cache-Control', 'no-store')
            if ($isolate) {
                # Cross-origin isolation: browsers define SharedArrayBuffer only on such pages, and Unity's loader
                # rejects multithreaded builds without it. Sent on every response (pthread workers need it too).
                $res.AddHeader('Cross-Origin-Opener-Policy', 'same-origin')
                $res.AddHeader('Cross-Origin-Embedder-Policy', 'require-corp')
                $res.AddHeader('Cross-Origin-Resource-Policy', 'cross-origin')
            }
            $fs = [IO.File]::Open($path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
            $length = $fs.Length; $start = [int64]0; $count = $length
            if (-not $encoding) {
                # Single ranges only ("bytes=a-b", "bytes=a-", "bytes=-n"); anything else gets the whole file.
                $res.AddHeader('Accept-Ranges', 'bytes')
                $range = "$($req.Headers['Range'])"
                if ($range -match '^bytes=(\d*)-(\d*)$' -and ($Matches[1] -or $Matches[2])) {
                    if ($Matches[1]) {
                        $start = [int64]$Matches[1]
                        $end = if ($Matches[2]) { [Math]::Min([int64]$Matches[2], $length - 1) } else { $length - 1 }
                    } else {
                        $start = [Math]::Max([int64]0, $length - [int64]$Matches[2]); $end = $length - 1
                    }
                    if ($start -ge $length -or $end -lt $start) {
                        $status = 416; $count = 0
                        $res.AddHeader('Content-Range', "bytes */$length")
                    } else {
                        $status = 206; $count = $end - $start + 1
                        $res.AddHeader('Content-Range', "bytes $start-$end/$length")
                    }
                }
            }
            $res.StatusCode = $status
            $res.ContentLength64 = $count
            if ($req.HttpMethod -ne 'HEAD' -and $count -gt 0) {
                [void]$fs.Seek($start, [IO.SeekOrigin]::Begin)
                $buf = [byte[]]::new(262144)
                $left = $count
                $started = $true
                while ($left -gt 0) {
                    $n = $fs.Read($buf, 0, [int][Math]::Min([int64]$buf.Length, $left))
                    if ($n -le 0) { throw "File shrank while serving $path" }
                    $res.OutputStream.Write($buf, 0, $n)
                    $left -= $n
                }
            }
        }
    } catch {
        if ($started) { $note = " (stopped: $($_.Exception.Message))" } else { $status = 500; $note = " ERROR $($_.Exception.Message)" }
    } finally {
        if ($fs) { $fs.Dispose() }
        if (-not $started) { try { $res.StatusCode = $status; if ($status -ge 400) { $res.ContentLength64 = 0 } } catch { } }
        if ($started -and $note) { try { $res.Abort() } catch { } } else { try { $res.Close() } catch { } }
        [Console]::Out.WriteLine(('{0} {1} {2}{3}' -f [DateTime]::Now.ToString('HH:mm:ss'), $status, $req.Url.AbsolutePath, $note))
    }
}

$pool = [RunspaceFactory]::CreateRunspacePool(1, 16)
$pool.Open()
$busy = New-Object Collections.ArrayList

$listener = New-Object Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")
$listener.Start()
Write-Host "SERVING $Root at http://localhost:$Port/ isolation=$(-not $NoIsolation)"

while ($listener.IsListening) {
    $ctx = $listener.GetContext()
    $ps = [PowerShell]::Create()
    $ps.RunspacePool = $pool
    [void]$ps.AddScript($handler).AddArgument($ctx).AddArgument($Root).AddArgument($types).AddArgument([bool](-not $NoIsolation))
    [void]$busy.Add(@($ps, $ps.BeginInvoke()))
    for ($i = $busy.Count - 1; $i -ge 0; $i--) {
        if ($busy[$i][1].IsCompleted) { $busy[$i][0].Dispose(); $busy.RemoveAt($i) }
    }
}
