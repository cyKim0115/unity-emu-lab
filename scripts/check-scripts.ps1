# Static checks for the PowerShell scripts (CI runs it on Windows PowerShell 5.1; run it before committing a .ps1):
# - ASCII only: Windows PowerShell 5.1 reads a .ps1 without BOM in the ANSI code page (CP949 here), so any
#   non-ASCII byte turns into garbage and can break the parse.
# - No parse errors in Windows PowerShell 5.1's own parser.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\check-scripts.ps1
# Exit 0 and CHECK_SCRIPTS OK, or exit 1 with one line per problem.
$ErrorActionPreference = 'Stop'
$problems = 0
$files = @(Get-ChildItem -LiteralPath $PSScriptRoot -Filter '*.ps1' -File | Sort-Object Name)
foreach ($f in $files) {
    $bytes = [IO.File]::ReadAllBytes($f.FullName)
    $line = 1
    for ($i = 0; $i -lt $bytes.Length; $i++) {
        if ($bytes[$i] -eq 10) { $line++ }
        elseif ($bytes[$i] -gt 127) {
            Write-Host "NON_ASCII $($f.Name):$line byte 0x$('{0:X2}' -f $bytes[$i])"
            $problems++
            break
        }
    }
    $tokens = $null; $errors = $null
    [void][Management.Automation.Language.Parser]::ParseFile($f.FullName, [ref]$tokens, [ref]$errors)
    foreach ($e in @($errors)) {
        Write-Host "PARSE $($f.Name):$($e.Extent.StartLineNumber) $($e.Message)"
        $problems++
    }
}
if ($problems) {
    Write-Host "CHECK_SCRIPTS FAIL problems=$problems files=$($files.Count) powershell=$($PSVersionTable.PSVersion)"
    exit 1
}
Write-Host "CHECK_SCRIPTS OK files=$($files.Count) powershell=$($PSVersionTable.PSVersion)"
