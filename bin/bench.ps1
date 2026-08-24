# Interactive dev-bench runner — pick tier or scenario, then run evals/dev-bench.mjs.
# Usage: .\bin\bench.ps1
#        .\bin\bench.ps1 -SkipJudge -KeepWorkspace
#        .\bin\bench.ps1 -Resume
#        .\bin\bench.ps1 -Reset

param(
    [switch]$SkipJudge,
    [switch]$KeepWorkspace,
    [switch]$Flat,
    [switch]$Resume,
    [switch]$Reset,
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$ExtraArgs
)

$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$BenchScript = Join-Path $RepoRoot "evals\dev-bench.mjs"
$CheckpointPath = Join-Path $RepoRoot ".halo-agent\bench-checkpoint.json"

function Test-NodeReady {
    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) {
        [Console]::Error.WriteLine("dev-bench needs Node.js 20 or newer, and 'node' was not found on PATH.")
        [Console]::Error.WriteLine("Install it with:  winget install OpenJS.NodeJS.LTS")
        exit 10
    }

    & node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 20 ? 0 : 1)"
    if ($LASTEXITCODE -ne 0) {
        $found = & node -v
        [Console]::Error.WriteLine("dev-bench needs Node.js 20 or newer; found $found.")
        exit 10
    }
}

function Get-ScenarioCatalog {
    Push-Location $RepoRoot
    try {
        $json = & node --input-type=module -e "import { SCENARIOS } from './evals/scenarios.mjs'; console.log(JSON.stringify(SCENARIOS.map((s) => ({ name: s.name, tier: s.tier }))));"
        if ($LASTEXITCODE -ne 0 -or -not $json) {
            throw "Could not load scenarios from evals/scenarios.mjs"
        }
        return @($json | ConvertFrom-Json)
    }
    finally {
        Pop-Location
    }
}

function Get-BenchCheckpoint {
    if (-not (Test-Path $CheckpointPath)) { return $null }
    try {
        return Get-Content $CheckpointPath -Raw | ConvertFrom-Json
    }
    catch {
        return $null
    }
}

function Reset-BenchCheckpoint {
    Push-Location $RepoRoot
    try {
        & node $BenchScript --reset
        if ($LASTEXITCODE -ne 0) {
            throw "Failed to reset bench checkpoint (exit $LASTEXITCODE)"
        }
    }
    finally {
        Pop-Location
    }
}

function Read-MenuChoice {
    param(
        [string]$Prompt,
        [string[]]$ValidChoices
    )

    while ($true) {
        $choice = (Read-Host $Prompt).Trim()
        if ($choice -in $ValidChoices) {
            return $choice
        }
        Write-Host "  Invalid choice. Enter one of: $($ValidChoices -join ', ')" -ForegroundColor Yellow
    }
}

function Show-TierMenu {
    param([int[]]$Tiers)

    Write-Host ""
    Write-Host "  A) All tiers (progression through tier $($Tiers[-1]))"
    foreach ($tier in $Tiers) {
        Write-Host "  $tier) Tier $tier only"
    }
    Write-Host "  B) Back"
    Write-Host ""

    $valid = @("B", "b", "A", "a") + ($Tiers | ForEach-Object { [string]$_ })
    $choice = Read-MenuChoice -Prompt "Tier" -ValidChoices $valid
    if ($choice -match '^[Bb]$') { return $null }
    if ($choice -match '^[Aa]$') { return @{ Mode = "all" } }
    return @{ Mode = "tier"; Tier = [int]$choice }
}

function Show-ScenarioMenu {
    param($Scenarios)

    Write-Host ""
    Write-Host "  A) All scenarios"
    for ($i = 0; $i -lt $Scenarios.Count; $i++) {
        $scenario = $Scenarios[$i]
        $num = $i + 1
        Write-Host ("  {0,2}) {1,-22} (tier {2})" -f $num, $scenario.Name, $scenario.Tier)
    }
    Write-Host "  0) Back"
    Write-Host ""

    $valid = @("0", "A", "a") + (1..$Scenarios.Count | ForEach-Object { [string]$_ })
    $choice = Read-MenuChoice -Prompt "Scenario" -ValidChoices $valid
    if ($choice -eq "0") { return $null }
    if ($choice -match '^[Aa]$') { return @{ Mode = "all" } }
    $index = [int]$choice - 1
    return @{ Mode = "scenario"; Name = $Scenarios[$index].Name }
}

function Build-BenchArgs {
    param(
        $Selection,
        [switch]$UseResume
    )

    $args = [System.Collections.Generic.List[string]]::new()

    switch ($Selection.Mode) {
        "all" {
            if ($Flat) { $args.Add("--flat") }
        }
        "tier" {
            $args.Add("--tier")
            $args.Add([string]$Selection.Tier)
            if ($Flat) { $args.Add("--flat") }
        }
        "scenario" {
            $args.Add("--scenario")
            $args.Add($Selection.Name)
        }
    }

    if ($SkipJudge) { $args.Add("--skip-judge") }
    if ($KeepWorkspace) { $args.Add("--keep-workspace") }
    if ($UseResume) { $args.Add("--resume") }
    if ($ExtraArgs) { $args.AddRange($ExtraArgs) }

    return $args.ToArray()
}

function Invoke-DevBench {
    param(
        [string[]]$BenchArgs,
        [switch]$UseResume
    )

    if ($UseResume -and ($BenchArgs -notcontains "--resume")) {
        $BenchArgs = @($BenchArgs) + @("--resume")
    }

    Write-Host ""
    Write-Host "Running: node evals/dev-bench.mjs $($BenchArgs -join ' ')" -ForegroundColor Cyan
    Write-Host ""

    Push-Location $RepoRoot
    try {
        & node $BenchScript @BenchArgs
        exit $LASTEXITCODE
    }
    finally {
        Pop-Location
    }
}

function Get-ResumeSelectionFromCheckpoint {
    param($Checkpoint)

    if (-not $Checkpoint) { return $null }

    $names = @($Checkpoint.scenarioNames)
    if ($names.Count -eq 0) { return $null }

    $label = [string]$Checkpoint.selectionLabel
    if ($label -match '^scenario (.+)$') {
        return @{ Mode = "scenario"; Name = $Matches[1] }
    }
    if ($label -match '^tier ≤(\d+) \(flat\)$') {
        return @{ Mode = "tier"; Tier = [int]$Matches[1]; Flat = $true }
    }
    if ($label -match '^tier ≤(\d+) \(progression\)$') {
        return @{ Mode = "tier"; Tier = [int]$Matches[1] }
    }
    if ($label -eq "all scenarios (flat)") {
        return @{ Mode = "all"; Flat = $true }
    }
    if ($label -eq "all scenarios (progression)") {
        return @{ Mode = "all" }
    }

    return $null
}

Test-NodeReady

if ($Reset) {
    Reset-BenchCheckpoint
    Write-Host "Bench checkpoint cleared." -ForegroundColor Green
    if (-not $Resume) {
        exit 0
    }
}

$scenarios = Get-ScenarioCatalog
$tiers = ($scenarios.Tier | Sort-Object -Unique)
$checkpoint = Get-BenchCheckpoint

if ($Resume) {
    if (-not $checkpoint) {
        Write-Host "No saved bench progress to resume." -ForegroundColor Yellow
        exit 1
    }
    $selection = Get-ResumeSelectionFromCheckpoint -Checkpoint $checkpoint
    if (-not $selection) {
        Write-Host "Could not reconstruct the interrupted run from the checkpoint." -ForegroundColor Yellow
        Write-Host "Use -Reset to clear it, then start a new run from the menu."
        exit 1
    }
    if ($selection.Flat) { $Flat = $true }
    $completed = @($checkpoint.completedNames).Count
    $total = @($checkpoint.scenarioNames).Count
    Write-Host ""
    Write-Host "Resuming: $completed / $total scenario(s) already completed ($($checkpoint.selectionLabel))" -ForegroundColor Cyan
    $benchArgs = Build-BenchArgs -Selection $selection -UseResume
    Invoke-DevBench -BenchArgs $benchArgs -UseResume
    exit $LASTEXITCODE
}

while ($true) {
    $checkpoint = Get-BenchCheckpoint
    $resumeHint = ""
    if ($checkpoint) {
        $completed = @($checkpoint.completedNames).Count
        $total = @($checkpoint.scenarioNames).Count
        $resumeHint = " ($completed/$total done: $($checkpoint.selectionLabel))"
    }

    Write-Host ""
    Write-Host "=== halo-agent dev bench ===" -ForegroundColor Green
    Write-Host ""
    Write-Host "  1) Run all scenarios (tier progression)"
    Write-Host "  2) Run all scenarios (flat, no tier pauses)"
    Write-Host "  3) Run by tier"
    Write-Host "  4) Run by scenario"
    if ($checkpoint) {
        Write-Host "  5) Resume interrupted run$resumeHint" -ForegroundColor Cyan
        Write-Host "  6) Reset saved progress"
    }
    Write-Host "  0) Exit"
    Write-Host ""

    $validMain = @("0", "1", "2", "3", "4")
    if ($checkpoint) { $validMain += @("5", "6") }
    $main = Read-MenuChoice -Prompt "Choice" -ValidChoices $validMain

    if ($main -eq "0") {
        exit 0
    }

    if ($main -eq "6") {
        Reset-BenchCheckpoint
        Write-Host "Bench checkpoint cleared." -ForegroundColor Green
        continue
    }

    $selection = $null
    $useResume = $false

    if ($main -eq "5") {
        $selection = Get-ResumeSelectionFromCheckpoint -Checkpoint $checkpoint
        if (-not $selection) {
            Write-Host "Could not reconstruct the interrupted run. Use option 6 to reset." -ForegroundColor Yellow
            continue
        }
        $useResume = $true
    }
    else {
        switch ($main) {
            "1" { $selection = @{ Mode = "all" } }
            "2" { $selection = @{ Mode = "all" }; $Flat = $true }
            "3" { $selection = Show-TierMenu -Tiers $tiers }
            "4" { $selection = Show-ScenarioMenu -Scenarios $scenarios }
        }
    }

    if (-not $selection) {
        continue
    }

    if ($selection.Flat) { $Flat = $true }

    $benchArgs = Build-BenchArgs -Selection $selection -UseResume:$useResume
    Invoke-DevBench -BenchArgs $benchArgs -UseResume:$useResume
    exit $LASTEXITCODE
}
