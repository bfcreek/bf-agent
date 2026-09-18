# /ha-train - Terminal-Bench training iteration(s): random TB sample + architecture-pattern plan.
#
# Usage (from repo root):
#   .\scripts\commands\ha-train.ps1                    # one iteration, 5 random TB tasks (exit 0 even if bench/judge failed)
#   .\scripts\commands\ha-train.ps1 -Count 3           # 3-task sample
#   .\scripts\commands\ha-train.ps1 -Iterations 100    # bench+plan loop; continues on any failure
#   .\scripts\commands\ha-train.ps1 -Iterations 100 -StartFrom 12
#   .\scripts\commands\ha-train.ps1 -Seed 42
#   .\scripts\commands\ha-train.ps1 -SkipBench
#   .\scripts\commands\ha-train.ps1 -DryRun

param(
    [int]$Count = 5,
    [int]$Iterations = 1,
    [int]$StartFrom = 1,
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
$TrainLog = Join-Path $RepoRoot "ha-train-log.md"

if (-not (Test-Path $TbMini)) {
    throw "Missing bench launcher: $TbMini"
}
if (-not (Test-Path $ProcessScript)) {
    throw "Missing recommendations processor: $ProcessScript"
}
if ($Count -lt 2) {
    throw "-Count must be at least 2 so pattern detection has a sample, not a single case."
}
if ($Iterations -lt 1) {
    throw "-Iterations must be at least 1."
}
if ($StartFrom -lt 1) {
    throw "-StartFrom must be at least 1."
}

function Invoke-TrainIteration {
    param(
        [int]$Index,
        [int]$Total,
        [string]$IterationSeed
    )

    Write-Host ""
    Write-Host "=== ha-train iteration $Index/$Total (seed $IterationSeed, count $Count) ===" -ForegroundColor Cyan
    Write-Host "  sample: $Count random Terminal-Bench tasks"
    Write-Host "  plan:   architecture patterns (not per-task judge tips)"
    Write-Host ""

    $benchExit = 0
    $planExit = 0
    $recCount = 0
    $notes = @()

    if (-not $SkipBench) {
        $forward = @{
            Count = $Count
            Seed  = $IterationSeed
        }
        if ($SkipJudge) { $forward.SkipJudge = $true }
        if ($DryRun) { $forward.DryRun = $true }
        if ($Compose) { $forward.Compose = $true }
        if ($Dataset) { $forward.Dataset = $Dataset }
        if ($Model) { $forward.Model = $Model }

        try {
            if ($ExtraArgs) {
                & $TbMini @forward @ExtraArgs
            } else {
                & $TbMini @forward
            }
            $benchExit = $LASTEXITCODE
        } catch {
            $benchExit = 1
            $notes += "bench threw: $($_.Exception.Message)"
            Write-Host "Bench failed: $($_.Exception.Message)" -ForegroundColor Yellow
        }

        if ($DryRun) {
            return @{ benchExit = $benchExit; planExit = 0; recCount = 0; notes = $notes }
        }
        if ($benchExit -ne 0) {
            $notes += "bench exit $benchExit"
            Write-Host "Bench exited $benchExit - still building pattern plan from the partial report." -ForegroundColor Yellow
        }
        Write-Host ""
    }

    Push-Location $RepoRoot
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        $planOutput = & node $ProcessScript --patterns --json $PlanJson --markdown $PlanMd 2>&1
        $planExit = $LASTEXITCODE
        foreach ($line in $planOutput) {
            if ($line -is [System.Management.Automation.ErrorRecord]) {
                Write-Host $line.ToString()
            } else {
                Write-Host $line
                if ($line -match '^recommendations:\s*(\d+)') {
                    $recCount = [int]$Matches[1]
                }
            }
        }
    } catch {
        $planExit = 1
        $notes += "plan threw: $($_.Exception.Message)"
        Write-Host "Pattern plan failed: $($_.Exception.Message)" -ForegroundColor Yellow
    } finally {
        $ErrorActionPreference = $prevEap
        Pop-Location
    }

    if ($planExit -ne 0) {
        $notes += "plan exit $planExit"
        Write-Host "Plan processor exited $planExit - continue to the next iteration." -ForegroundColor Yellow
    }

    return @{
        benchExit = $benchExit
        planExit  = $planExit
        recCount  = $recCount
        notes     = $notes
    }
}

function Append-TrainLog {
    param(
        [int]$Index,
        [int]$Total,
        [string]$IterationSeed,
        [int]$RecCount,
        [string[]]$Notes
    )

    $status = if ($Notes.Count -gt 0) { "fail: $($Notes -join '; ')" } else { "ok" }
    $line = "iteration $Index/$Total | seed $IterationSeed | count $Count | levers $RecCount | bench-plan: $status"
    Add-Content -Path $TrainLog -Value $line -Encoding utf8
}

$endAt = $StartFrom + $Iterations - 1
Write-Host "bf-agent /ha-train - $Iterations iteration(s), $Count TB task(s) each, indices $StartFrom..$endAt" -ForegroundColor Cyan
Write-Host "  failures (bench, judge, plan) do not stop the loop - only missing prerequisites throw" -ForegroundColor DarkGray
Write-Host ""

for ($i = $StartFrom; $i -le $endAt; $i++) {
    $iterationSeed = if ($Seed -and $Iterations -eq 1) { $Seed } else { Get-Random -Minimum 1 -Maximum 2147483647 }

    $result = Invoke-TrainIteration -Index $i -Total $endAt -IterationSeed $iterationSeed

    if ($DryRun) {
        exit $result.benchExit
    }

    if ($Iterations -gt 1) {
        Append-TrainLog -Index $i -Total $endAt -IterationSeed $iterationSeed -RecCount $result.recCount -Notes $result.notes
    }

    if ($i -lt $endAt) {
        Write-Host "Iteration $i done - continuing to $($i + 1)/$endAt." -ForegroundColor Green
    }
}

Write-Host ""
if ($Iterations -eq 1) {
    Write-Host "Done (seed $iterationSeed, count $Count). Assimilate pending pattern levers in bench-recommendations-plan.md, then run the next iteration." -ForegroundColor Green
} else {
    Write-Host "Done - completed iterations $StartFrom..$endAt. See $TrainLog for the bench/plan log." -ForegroundColor Green
    Write-Host "Assimilate each bench-recommendations-plan.md snapshot before the next full loop if plans changed per iteration." -ForegroundColor DarkGray
}

# Always exit 0 so unattended loops and agents continue after bench/judge/plan failures.
exit 0
