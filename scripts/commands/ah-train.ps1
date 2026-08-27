# /ah-train - single training iteration: 1 random TB task + recommendations plan.
#
# Usage (from repo root):
#   .\scripts\commands\ah-train.ps1
#   .\scripts\commands\ah-train.ps1 -Seed 42
#   .\scripts\commands\ah-train.ps1 -SkipBench
#   .\scripts\commands\ah-train.ps1 -DryRun

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

if (-not $Seed) {
    $Seed = Get-Random -Minimum 1 -Maximum 2147483647
}

Write-Host "halo-agent /ah-train - 1 random Terminal-Bench task + recommendations" -ForegroundColor Cyan
Write-Host "  sample: 1 task from TB 2.1 catalog (seed $Seed)"
Write-Host "  plan:   bench-recommendations-plan.json + bench-recommendations-plan.md"
Write-Host ""

$benchExit = 0
$planExit = 0

if (-not $SkipBench) {
    $forward = @{
        Count = 1
        Seed  = $Seed
    }
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
Write-Host "Done (seed $Seed). Assimilate bench-recommendations-plan.md, then run the next iteration." -ForegroundColor Green
exit 0
