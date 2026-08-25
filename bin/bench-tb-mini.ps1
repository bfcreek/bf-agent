# Random 5-task Terminal-Bench subset (Harbor / Docker sandboxes).
# Shuffles the TB 2.1 catalog — Harbor --n-tasks is first-N, not random.
#
# Usage: .\bin\bench-tb-mini.ps1
#        .\bin\bench-tb-mini.ps1 -Count 5 -Seed 42
#        .\bin\bench-tb-mini.ps1 -DryRun
#        .\bin\bench-tb-mini.ps1 -SkipJudge
#        .\bin\bench-tb-mini.ps1 -Compose
#
# Full suite: .\bin\bench-tb.ps1
# Local dev bench: .\bin\bench-local.ps1

param(
    [int]$Count = 5,
    [string]$Seed,
    [switch]$Check,
    [switch]$SkipJudge,
    [switch]$List,
    [switch]$DryRun,
    [switch]$Compose,
    [string]$Dataset,
    [string]$Model,
    [string]$Include,
    [string]$FromJob,
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$ExtraArgs
)

$ErrorActionPreference = "Stop"
$Tb = Join-Path $PSScriptRoot "bench-tb.ps1"

if ($Count -lt 1) {
    [Console]::Error.WriteLine("-Count must be a positive integer.")
    exit 1
}

$forward = @{
    Sample = $Count
}
if ($Seed) { $forward.Seed = $Seed }
if ($Check) { $forward.Check = $true }
if ($SkipJudge) { $forward.SkipJudge = $true }
if ($List) { $forward.List = $true }
if ($DryRun) { $forward.DryRun = $true }
if ($Compose) { $forward.Compose = $true }
if ($Dataset) { $forward.Dataset = $Dataset }
if ($Model) { $forward.Model = $Model }
if ($Include) { $forward.Include = $Include }
if ($FromJob) { $forward.FromJob = $FromJob }

if (-not $List -and -not $Check) {
    Write-Host "Terminal-Bench mini: random $Count-task sample" -ForegroundColor Cyan
    if ($Seed) { Write-Host "  seed:   $Seed  (re-run with -Seed $Seed to repeat this draw)" }
    else { Write-Host "  seed:   assigned at run time and printed as 'sample: ... (seed N)'" }
    Write-Host ""
}

if ($ExtraArgs) {
    & $Tb @forward @ExtraArgs
} else {
    & $Tb @forward
}
exit $LASTEXITCODE
