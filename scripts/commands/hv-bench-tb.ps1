# /hv-bench-tb - random 2-task Terminal-Bench mini run, then recommendations plan.
#
# Usage (from repo root):
#   .\scripts\commands\hv-bench-tb.ps1
#   .\scripts\commands\hv-bench-tb.ps1 -Seed 42
#   .\scripts\commands\hv-bench-tb.ps1 -SkipBench
#   .\scripts\commands\hv-bench-tb.ps1 -DryRun

param(
    [string]$Seed,
    [switch]$SkipBench,
    [switch]$SkipJudge,
    [switch]$DryRun,
    [switch]$Compose,
    [string]$Dataset,
    [string]$Model,
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$ExtraArgs
)

$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$TbMini = Join-Path $RepoRoot "bin\bench-tb-mini.ps1"
$ProcessScript = Join-Path $RepoRoot "evals\process-recommendations.mjs"
$PlanJson = Join-Path $RepoRoot "bench-recommendations-plan.json"
$PlanMd = Join-Path $RepoRoot "bench-recommendations-plan.md"

if (-not (Test-Path $TbMini)) {
    throw "Missing bench launcher: $TbMini"
}
if (-not (Test-Path $ProcessScript)) {
    throw "Missing recommendations processor: $ProcessScript"
}

Write-Host "halo-agent /hv-bench-tb - 2 random Terminal-Bench tasks + recommendations" -ForegroundColor Cyan
Write-Host "  sample: 2 tasks from TB 2.1 catalog (random seed unless -Seed is set)"
Write-Host "  plan:   bench-recommendations-plan.json + bench-recommendations-plan.md"
Write-Host ""

$benchExit = 0
$planExit = 0

if (-not $SkipBench) {
    $forward = @{
        Count = 2
    }
    if ($Seed) { $forward.Seed = $Seed }
    if ($SkipJudge) { $forward.SkipJudge = $true }
    if ($DryRun) { $forward.DryRun = $true }
    if ($Compose) { $forward.Compose = $true }
    if ($Dataset) { $forward.Dataset = $Dataset }
    if ($Model) { $forward.Model = $Model }

    if ($ExtraArgs) {
        & $TbMini @forward @ExtraArgs
    } else {
        & $TbMini @forward
    }
    $benchExit = $LASTEXITCODE
    if ($DryRun) {
        exit $benchExit
    }
    Write-Host ""
}

Push-Location $RepoRoot
try {
    & node $ProcessScript --json $PlanJson --markdown $PlanMd
    $planExit = $LASTEXITCODE
}
finally {
    Pop-Location
}

if ($planExit -ne 0) {
    exit $planExit
}

if ($benchExit -ne 0) {
    Write-Host "Bench exited $benchExit - recommendations plan was still generated from the partial report." -ForegroundColor Yellow
    exit $benchExit
}

Write-Host ""
Write-Host "Done. Open bench-recommendations-plan.md and implement pending items." -ForegroundColor Green
exit 0
