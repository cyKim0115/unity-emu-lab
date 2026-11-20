# Protect the person's Unity project around a build (AGENTS.md rule 5):
#   -Mode Snapshot  ONCE, BEFORE the first build: record what is already changed. prebuild.patch backs up the tracked
#                   changes only; untracked files are listed and hashed, never moved or reverted, and not backed up.
#                   Keep the snapshot across rebuilds (marker, -emuArm64, second target). A second Snapshot refuses
#                   while paths changed since the first one (possibly unreported build changes) unless -Replace.
#   -Mode Report    after the LAST build: list paths the build changed or created since the snapshot (with a content
#                   hash each), and files that were already changed before the build and changed again meanwhile
#                   (never reverted)
#   -Mode Revert    ONLY after the person agreed to the Report list: back up, revert the reported changed files
#                   and move the reported created files into the backup folder. -Keep "a|b" skips paths the person
#                   edited themselves (any path Report printed). Anything new or changed since the Report stops the
#                   revert. On success the snapshot and report are archived, so the next build starts with a new Snapshot.
# Report and Revert refuse while the project is open in Unity (Temp\UnityLockfile held): the Editor keeps the build's
# settings in memory and writes them back on save or quit. Snapshot works with the Editor open (-SkipBuild flow), but
# not while a batchmode Unity holds the project (a build is running).
# Uses git -z, literal pathspecs and UTF-8, so spaces, [brackets] and Korean names are safe, and works when the
# project is a subfolder of a larger repo. Snapshot and Report change nothing in the project.
#
#   project-guard.ps1 -ProjectPath <p> -Mode Snapshot [-Replace]
#   project-guard.ps1 -ProjectPath <p> -Mode Report
#   project-guard.ps1 -ProjectPath <p> -Mode Revert [-Keep "Assets/A.cs|Assets/B.asset"]
param(
    [Parameter(Mandatory)] [string]$ProjectPath,
    [Parameter(Mandatory)] [ValidateSet('Snapshot', 'Report', 'Revert')] [string]$Mode,
    [string]$Keep = '',              # repo-root relative paths as printed by Report, separated by |
    [switch]$Replace,                # Snapshot: archive an existing snapshot even though paths changed since it
    [string]$StateDir                # default: artifacts\guard\<project folder>-<hash of repo root + prefix>
)
. "$PSScriptRoot\common.ps1"

$utf8 = New-Object Text.UTF8Encoding $false
$prevOut = $null
try { $prevOut = [Console]::OutputEncoding; [Console]::OutputEncoding = $utf8 } catch { }

function Invoke-Git([string[]]$GitArgs) {
    # Returns stdout as one string (NUL separators kept); throws on a non-zero exit.
    $ErrorActionPreference = 'Continue'
    $out = & git -c core.quotePath=false --literal-pathspecs @GitArgs 2>&1
    $code = $LASTEXITCODE
    $text = ($out | Where-Object { $_ -isnot [Management.Automation.ErrorRecord] } | ForEach-Object { "$_" }) -join "`n"
    $err = ($out | Where-Object { $_ -is [Management.Automation.ErrorRecord] } | ForEach-Object { $_.Exception.Message }) -join ' '
    if ($code -ne 0) { throw "git $($GitArgs -join ' ') failed ($code): $err" }
    return $text
}

function Get-Status([string]$Top, [string]$Prefix) {
    # Changed paths under the project, repo-root relative: @{ Path; XY }. Renames/copies keep the new path.
    $spec = if ($Prefix) { $Prefix } else { '.' }
    $raw = Invoke-Git @('-C', $Top, 'status', '--porcelain=v1', '-z', '-uall', '--', $spec)
    $parts = @($raw -split "`0" | Where-Object { $_ -ne '' })
    $list = @()
    for ($i = 0; $i -lt $parts.Count; $i++) {
        $e = $parts[$i]
        $xy = $e.Substring(0, 2); $path = $e.Substring(3)
        if ('R', 'C' -contains $xy[0] -or 'R', 'C' -contains $xy[1]) { $i++ }   # the next field is the old path
        $list += [pscustomobject]@{ Path = $path; XY = $xy }
    }
    return $list
}

function Get-FileHashText([string]$Top, [string]$Path) {
    $full = [IO.Path]::Combine($Top, $Path.Replace('/', '\'))
    if (-not [IO.File]::Exists($full)) { return 'missing' }
    $sha = [Security.Cryptography.SHA256]::Create()
    $fs = [IO.File]::Open($full, 'Open', 'Read', 'ReadWrite')   # stream: files of 2 GB+ and no full copy in memory
    try { return [BitConverter]::ToString($sha.ComputeHash($fs)) } finally { $fs.Dispose(); $sha.Dispose() }
}

function Write-Json([string]$Path, $Object) { [IO.File]::WriteAllText($Path, ($Object | ConvertTo-Json -Depth 4), $utf8) }
function Read-Json([string]$Path) { [IO.File]::ReadAllText($Path, $utf8) | ConvertFrom-Json }

function Move-ToArchive([string]$Dir, [string]$Name, [string]$Stamp) {
    # snapshot.json -> snapshot-<stamp>.json (-2, -3... when taken). Returns the new path, or nothing when absent.
    $src = [IO.Path]::Combine($Dir, $Name)
    if (-not [IO.File]::Exists($src)) { return }
    $base = [IO.Path]::GetFileNameWithoutExtension($Name); $ext = [IO.Path]::GetExtension($Name)
    $dst = [IO.Path]::Combine($Dir, "$base-$Stamp$ext"); $n = 2
    while ([IO.File]::Exists($dst)) { $dst = [IO.Path]::Combine($Dir, "$base-$Stamp-$n$ext"); $n++ }
    [IO.File]::Move($src, $dst)
    return $dst
}

function Get-BuildHolders($Holders) {
    # A batchmode Unity that is not an Editor's asset import worker (those are batchmode too) = a build is running.
    return @($Holders | Where-Object { $_ -and $_.Batchmode -and -not $_.Worker })
}

function Format-Holders($Holders) {
    $h = @($Holders | Where-Object { $_ })
    if (-not $h.Count) { return 'Temp\UnityLockfile is locked, but no running Unity.exe names this project in -projectPath: ask the person which Editor or tool has it open' }
    $main = @($h | Where-Object { -not $_.Worker })
    if ($main.Count) { $h = $main }   # import workers belong to the Editor or build listed
    return (@($h | ForEach-Object {
        if ($_.Worker) { "asset import worker pid $($_.ProcessId)" } elseif ($_.Batchmode) { "batchmode Unity pid $($_.ProcessId)" } else { "Unity Editor pid $($_.ProcessId)" } }) -join ', ')
}

try {
    Assert-PathArg 'ProjectPath' $ProjectPath
    Assert-PathArg 'StateDir' $StateDir
    $ProjectPath = Remove-TrailingSeparator (Resolve-Path -LiteralPath $ProjectPath -ErrorAction Stop).ProviderPath
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
        # GUI clients (SourceTree, Fork, GitHub Desktop) bundle their own git and often leave it off PATH.
        $gitAt = $null; $d = $ProjectPath
        while ($d -and -not $gitAt) { if (Test-Path -LiteralPath ([IO.Path]::Combine($d, '.git'))) { $gitAt = $d } else { $d = [IO.Path]::GetDirectoryName($d) } }
        if ($gitAt) { throw "git not found on PATH, but the project is inside a git repo ($gitAt\.git). Ask the person to install Git for Windows or add their git client's git.exe to PATH, open a new terminal, then rerun. Nothing changed." }
        throw "git not found on PATH (and no .git folder above $ProjectPath). If the project is not under git, ask the person first and copy ProjectSettings and Packages to a backup folder (AGENTS.md rule 5). Nothing changed."
    }
    $ErrorActionPreference = 'Continue'
    $probe = @(& git -C $ProjectPath rev-parse --show-toplevel 2>&1 | ForEach-Object { "$_" })
    $probeCode = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
    if (($probe -join ' ') -match 'dubious ownership|is owned by someone else') { throw 'git refused the project (dubious ownership): run outside the agent sandbox (AGENTS.md rule 11).' }
    if ($probeCode -ne 0) { throw "not a git work tree: $ProjectPath. Without git, ask the person first and copy ProjectSettings and Packages to a backup folder (AGENTS.md rule 5)." }
    $top = (Invoke-Git @('-C', $ProjectPath, 'rev-parse', '--show-toplevel')).Trim().Replace('/', '\')
    $prefix = (Invoke-Git @('-C', $ProjectPath, 'rev-parse', '--show-prefix')).Trim()
    try { $head = (Invoke-Git @('-C', $top, 'rev-parse', '--verify', 'HEAD')).Trim() }
    catch { throw "The repository at $top has no commit yet, so changes cannot be compared. Ask the person to make a first commit, or to copy the project folder as a backup, before the build." }
    if (-not $StateDir) {
        $sha = [Security.Cryptography.SHA256]::Create()
        $key = -join ($sha.ComputeHash($utf8.GetBytes("$top|$prefix".ToLowerInvariant()))[0..3] | ForEach-Object { $_.ToString('x2') })
        $sha.Dispose()
        $leaf = (Split-Path -Leaf $ProjectPath) -replace '[^\w.-]', '_'
        $StateDir = Join-Path $RepoRoot "artifacts\guard\$leaf-$key"
    }
    [void][IO.Directory]::CreateDirectory($StateDir)
    $snapFile = Join-Path $StateDir 'snapshot.json'
    $reportFile = Join-Path $StateDir 'report.json'
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'

    if ($Mode -eq 'Snapshot') {
        if (Test-ProjectLocked $ProjectPath) {
            $holders = @(Get-UnityProcessesForProject $ProjectPath)
            if (@(Get-BuildHolders $holders).Count) { throw "A batchmode Unity is running on this project ($(Format-Holders $holders)): a snapshot taken during a build would count its changes as the person's own work. Wait for it to end. Nothing changed." }
            Write-Host "NOTE: the project is open ($(Format-Holders $holders)). Fine only if the person builds in this Editor (-SkipBuild flow). For a batchmode build, ask them to close the Editor first and take the snapshot after it is closed: what the Editor writes when it quits would otherwise count as build changes. The Editor must be closed before -Mode Report and Revert."
        }
        $entries = @(Get-Status $top $prefix | ForEach-Object {
            [pscustomobject]@{ Path = $_.Path; XY = $_.XY; Hash = (Get-FileHashText $top $_.Path) } })
        $stashRef = ''
        try { $stashRef = (Invoke-Git @('-C', $top, 'rev-parse', '-q', '--verify', 'refs/stash')).Trim() } catch { }
        if (Test-Path -LiteralPath $snapFile) {
            $when = (Get-Item -LiteralPath $snapFile).LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss')
            $old = $null
            try { $old = Read-Json $snapFile } catch { }
            if (-not $old -or $old.top -ne $top -or $old.prefix -ne $prefix) {
                $whose = if ($old) { "a snapshot of another project ($($old.project), $when)" } else { "an unreadable snapshot.json ($when)" }
                if (-not $Replace) { throw "$StateDir already holds $whose. Pass the right -StateDir, or -Replace to archive it and start over. Nothing changed." }
            } else {
                $oldHash = @{}
                foreach ($e in @($old.entries)) { if ($e) { $oldHash[$e.Path] = $e.Hash } }
                $since = @($entries | Where-Object { -not $oldHash.ContainsKey($_.Path) -or $oldHash[$_.Path] -ne $_.Hash })
                # Paths that disappeared pass only when a commit or a stash explains it: a build can also delete or reset files.
                $nowPaths = @{}; foreach ($e in $entries) { $nowPaths[$e.Path] = $true }
                $gone = @(@($old.entries) | Where-Object { $_ -and -not $nowPaths.ContainsKey($_.Path) })
                $explained = ($old.head -ne $head) -or ("$($old.stash)" -ne $stashRef)
                if (-not $explained) { $since += $gone }
                if ($since.Count -and -not $Replace) {
                    $since | ForEach-Object {
                        if ($nowPaths.ContainsKey($_.Path)) { Write-Host "  changed since the last snapshot: $($_.XY) $($_.Path)" }
                        else { Write-Host "  gone since the last snapshot: $($_.XY) $($_.Path) (no commit or stash explains it: removed or reset by a build?)" }
                    }
                    $rep = if (Test-Path -LiteralPath $reportFile) { ' A Report was taken from it but no Revert followed.' } else { '' }
                    throw "A snapshot from $when (HEAD $($old.head)) already exists and $($since.Count) path(s) changed since it, possibly an earlier build's changes that were never reverted.$rep Keep the first snapshot across rebuilds and run -Mode Report after the last build. Pass -Replace only when the person says these are their own changes. Nothing changed."
                }
            }
        }
        $tracked = @($entries | Where-Object { $_.XY -ne '??' })
        $untracked = @($entries | Where-Object { $_.XY -eq '??' })
        $patch = Join-Path $StateDir 'prebuild.patch'
        $patchNew = "$patch.new"   # written before the old state is archived, so a failed diff leaves the old snapshot in place
        if ([IO.File]::Exists($patchNew)) { [IO.File]::Delete($patchNew) }
        if ($tracked.Count) {
            Invoke-Git @('-C', $top, 'diff', '--binary', 'HEAD', "--output=$patchNew", '--', $(if ($prefix) { $prefix } else { '.' })) | Out-Null
        }
        # Archive (never delete) the previous cycle's files, so a stale prebuild.patch or report cannot be mistaken for this one.
        $archived = @('snapshot.json', 'report.json', 'prebuild.patch' | ForEach-Object { Move-ToArchive $StateDir $_ $stamp } | Where-Object { $_ })
        if ([IO.File]::Exists($patchNew)) { [IO.File]::Move($patchNew, $patch) }
        Write-Json $snapFile ([ordered]@{ project = $ProjectPath; top = $top; prefix = $prefix; head = $head; stash = $stashRef; entries = $entries })
        Write-Host "GUARD_SNAPSHOT changed_before_build=$($entries.Count) tracked=$($tracked.Count) untracked=$($untracked.Count) state=$StateDir"
        $archived | ForEach-Object { Write-Host "  archived previous $_" }
        $entries | ForEach-Object { Write-Host "  $($_.XY) $($_.Path)" }
        if ($tracked.Count) { Write-Host "  backup=$patch holds the tracked changes only (git diff HEAD)." }
        if ($untracked.Count) { Write-Host "  The $($untracked.Count) untracked file(s) (??) are NOT backed up: they are only listed and hashed. The guard never moves or reverts them, but cannot restore them if the build overwrites them." }
        if ($entries.Count) { Write-Host 'Ask the person: commit/stash these first, or build as is. If they commit/stash, run -Mode Snapshot again.' }
        Write-Host 'Keep this snapshot for every rebuild (marker, -emuArm64, second target) and run -Mode Report after the last build.'
        return
    }

    if (-not (Test-Path -LiteralPath $snapFile)) {
        $last = @(Get-ChildItem -LiteralPath $StateDir -Filter 'snapshot-*.json' -File -ErrorAction SilentlyContinue | Sort-Object Name -Descending | Select-Object -First 1)
        $hint = if ($last.Count) { " The last one was archived ($($last[0].Name)) after a Revert: that cycle is finished; take a new snapshot before the next build." } else { '' }
        throw "No snapshot in $StateDir.$hint A snapshot must be taken BEFORE the build; taking one now would count the build's changes as the person's own work."
    }
    $snap = Read-Json $snapFile
    if ($snap.top -ne $top -or $snap.prefix -ne $prefix) { throw "The snapshot in $StateDir belongs to another project ($($snap.project)). Pass the right -StateDir or take a new snapshot before the next build." }
    $nothing = if ($Mode -eq 'Revert') { 'Nothing reverted.' } else { 'No report written.' }
    if (Test-ProjectLocked $ProjectPath) {
        $holders = @(Get-UnityProcessesForProject $ProjectPath)
        if (@(Get-BuildHolders $holders).Count) { throw "A batchmode Unity is still running on this project ($(Format-Holders $holders)). Wait for the build to end, then run -Mode $Mode again. $nothing" }
        throw "The project is open in Unity ($(Format-Holders $holders)). Ask the person to close the Unity Editor before -Mode ${Mode}: the Editor keeps the build's settings (PlayerSettings and other ProjectSettings) in memory and writes them back on its next save or on quit, which silently undoes a revert. $nothing"
    }
    $headMoved = $snap.head -ne $head
    $before = @{}
    foreach ($e in @($snap.entries)) { if ($e) { $before[$e.Path] = $e } }
    $now = @(Get-Status $top $prefix)
    $newTracked = @($now | Where-Object { -not $before.ContainsKey($_.Path) -and $_.XY -ne '??' -and $_.XY[0] -eq ' ' })
    $newStaged = @($now | Where-Object { -not $before.ContainsKey($_.Path) -and $_.XY -ne '??' -and $_.XY[0] -ne ' ' })
    $newUntracked = @($now | Where-Object { -not $before.ContainsKey($_.Path) -and $_.XY -eq '??' })
    $touched = @($before.Values | Where-Object { (Get-FileHashText $top $_.Path) -ne $_.Hash })

    if ($Mode -eq 'Report') {
        $report = [ordered]@{
            head = $head
            changed = @($newTracked | ForEach-Object Path)
            created = @($newUntracked | ForEach-Object Path)
            staged_not_reverted = @($newStaged | ForEach-Object Path)
            preexisting_changed_meanwhile = @($touched | ForEach-Object Path)
            # Content at Report time: Revert refuses when a reported path changed after the person saw the list.
            hashes = @(@($newTracked) + @($newUntracked) | ForEach-Object { [ordered]@{ path = $_.Path; hash = (Get-FileHashText $top $_.Path) } })
        }
        Write-Json $reportFile $report
        if ($headMoved) { Write-Host "WARN: HEAD moved since the snapshot ($($snap.head) -> $head); commits made meanwhile are not build changes. Revert will refuse." }
        Write-Host "GUARD_REPORT changed=$($newTracked.Count) created=$($newUntracked.Count) staged=$($newStaged.Count) preexisting_touched=$($touched.Count)"
        $newTracked | ForEach-Object { Write-Host "  changed  $($_.Path)" }
        $newUntracked | ForEach-Object { Write-Host "  created  $($_.Path)" }
        $newStaged | ForEach-Object { Write-Host "  staged   $($_.Path) (not reverted)" }
        $touched | ForEach-Object { Write-Host "  touched  $($_.Path) (was already changed before the build; never reverted)" }
        Write-Host 'Show this list to the person. Ask which of these files they edited themselves during the build (pass them as -Keep "a|b") and whether to revert the rest (-Mode Revert).'
        return
    }

    # Revert: only what the person approved from the Report.
    if ($headMoved) { throw "HEAD moved since the snapshot ($($snap.head) -> $head): commits were made meanwhile, so the build's changes cannot be told apart. Nothing reverted." }
    if (-not (Test-Path -LiteralPath $reportFile)) { throw 'Run -Mode Report first and show its list to the person before reverting.' }
    $report = Read-Json $reportFile
    if ($null -eq $report.hashes) { throw 'The Report was written by an older project-guard without content hashes. Run -Mode Report again and show the list to the person. Nothing reverted.' }
    $keepSet = @{}
    foreach ($k in ($Keep -split '\|')) { $kk = $k.Trim().Replace('\', '/'); if ($kk) { $keepSet[$kk] = $true } }
    $approvedChanged = @{}; foreach ($p in @($report.changed)) { if ($p) { $approvedChanged[$p] = $true } }
    $approvedCreated = @{}; foreach ($p in @($report.created)) { if ($p) { $approvedCreated[$p] = $true } }
    $neverReverted = @{}; foreach ($p in (@($report.staged_not_reverted) + @($report.preexisting_changed_meanwhile))) { if ($p) { $neverReverted[$p] = $true } }
    $unknownKeep = @($keepSet.Keys | Where-Object { -not $approvedChanged.ContainsKey($_) -and -not $approvedCreated.ContainsKey($_) -and -not $neverReverted.ContainsKey($_) })
    if ($unknownKeep) { throw "-Keep names paths that are not in the Report: $($unknownKeep -join ', '). Copy them exactly as Report printed them. Nothing reverted." }
    $unreported = @(($newTracked + $newUntracked) | Where-Object { -not $approvedChanged.ContainsKey($_.Path) -and -not $approvedCreated.ContainsKey($_.Path) })
    if ($unreported) {
        $unreported | ForEach-Object { Write-Host "  new since Report: $($_.XY) $($_.Path)" }
        throw 'Files changed after the Report. Run -Mode Report again and show the new list to the person. Nothing reverted.'
    }
    # Kept paths are left alone, so later edits to them do not matter.
    $changedSince = @(@($report.hashes) | Where-Object { $_ -and -not $keepSet.ContainsKey($_.path) -and (Get-FileHashText $top $_.path) -ne $_.hash } | ForEach-Object { $_.path })
    if ($changedSince) {
        $changedSince | ForEach-Object { Write-Host "  changed since Report: $_" }
        throw "$($changedSince.Count) reported path(s) changed after the Report. Run -Mode Report again and show the new list to the person. Nothing reverted."
    }
    $toRevert = @($newTracked | Where-Object { $approvedChanged.ContainsKey($_.Path) -and -not $keepSet.ContainsKey($_.Path) } | ForEach-Object Path)
    $toMove = @($newUntracked | Where-Object { $approvedCreated.ContainsKey($_.Path) -and -not $keepSet.ContainsKey($_.Path) } | ForEach-Object Path)

    $backup = Join-Path $StateDir "revert-$stamp"
    [void][IO.Directory]::CreateDirectory($backup)
    $batch = 0
    for ($i = 0; $i -lt $toRevert.Count; $i += 40) {
        # At most 40 paths per git call to keep command lines short.
        $chunk = @($toRevert[$i..([Math]::Min($i + 39, $toRevert.Count - 1))])
        $batch++
        $patch = Join-Path $backup "build-changes-$batch.patch"
        Invoke-Git (@('-C', $top, 'diff', '--binary', "--output=$patch", '--') + $chunk) | Out-Null
        # The patch must cover exactly these paths and reverse-apply cleanly before anything is checked out.
        $num = Invoke-Git @('-C', $top, 'apply', '--numstat', '-z', $patch)
        $inPatch = @($num -split "`0" | Where-Object { $_ -ne '' } | ForEach-Object { ($_ -split "`t", 3)[2] } | Sort-Object -Unique)
        if (Compare-Object @($chunk | Sort-Object -Unique) $inPatch) { throw "Backup patch does not match the paths to revert ($patch). Stopped; earlier batches, if any, are already reverted." }
        Invoke-Git @('-C', $top, 'apply', '--check', '-R', $patch) | Out-Null
        Invoke-Git (@('-C', $top, 'checkout', '--') + $chunk) | Out-Null
        $chunk | ForEach-Object { Write-Host "  reverted $_" }
    }
    foreach ($p in $toMove) {
        $src = [IO.Path]::Combine($top, $p.Replace('/', '\'))
        $dst = [IO.Path]::Combine($backup, 'created', $p.Replace('/', '\'))
        [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($dst))
        [IO.File]::Move($src, $dst)
        Write-Host "  moved    $p -> $dst"
    }
    # Folders the moved files leave empty (e.g. Assets\EmuLab\Editor from the template) would make Unity create a
    # folder .meta again on the next import. Remove them bottom-up, only while empty, never above the project folder,
    # and never a folder whose <folder>.meta is still there (a folder the project already had keeps its tracked .meta).
    $projNorm = $ProjectPath.TrimEnd('\')
    $dirs = @($toMove | ForEach-Object { [IO.Path]::GetDirectoryName([IO.Path]::Combine($top, $_.Replace('/', '\'))) } |
        Sort-Object -Unique | Sort-Object { $_.Length } -Descending)
    foreach ($d in $dirs) {
        $cur = $d
        while ($cur -and $cur.Length -gt $projNorm.Length -and $cur.StartsWith($projNorm + '\', [StringComparison]::OrdinalIgnoreCase) -and
               [IO.Directory]::Exists($cur) -and -not [IO.File]::Exists("$cur.meta") -and
               -not [IO.Directory]::EnumerateFileSystemEntries($cur).GetEnumerator().MoveNext()) {
            [IO.Directory]::Delete($cur)
            Write-Host "  removed empty folder $($cur.Substring($projNorm.Length + 1))"
            $cur = [IO.Path]::GetDirectoryName($cur)
        }
    }
    $keepSet.Keys | ForEach-Object {
        if ($neverReverted.ContainsKey($_)) { Write-Host "  kept     $_ (staged or touched: never reverted anyway)" }
        else { Write-Host "  kept     $_ (person edited it)" }
    }
    Write-Host "GUARD_REVERT reverted=$($toRevert.Count) moved=$($toMove.Count) kept=$($keepSet.Count) staged_left=$($newStaged.Count) preexisting_left=$($touched.Count) backup=$backup"
    # This cycle is done: archive its state so the next build starts with a fresh Snapshot.
    $archived = @('snapshot.json', 'report.json', 'prebuild.patch' | ForEach-Object { Move-ToArchive $StateDir $_ $stamp } | Where-Object { $_ })
    $archived | ForEach-Object { Write-Host "  archived $_" }
    Write-Host 'Snapshot and report archived: take a new -Mode Snapshot before the next build.'
}
finally {
    if ($prevOut) { try { [Console]::OutputEncoding = $prevOut } catch { } }
}
