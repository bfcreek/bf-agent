# Interactive dev-bench runner — pick tier, scenario, or language, then run evals/dev-bench.mjs.
# Usage: .\bin\bench.ps1
#        .\bin\bench.ps1 -SkipJudge -KeepWorkspace
#        .\bin\bench.ps1 -Language csharp
#        .\bin\bench.ps1 -Language python -Flat
#        .\bin\bench.ps1 -Resume
#        .\bin\bench.ps1 -Resume -Language csharp
#        .\bin\bench.ps1 -Reset
#        .\bin\bench.ps1 -Reset -Language python

param(
    [switch]$SkipJudge,
    [switch]$KeepWorkspace,
    [switch]$Flat,
    [switch]$Resume,
    [switch]$Reset,
    [ValidateSet("js", "javascript", "python", "py", "csharp", "cs")]
    [string]$Language,
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$ExtraArgs
)

$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$BenchScript = Join-Path $RepoRoot "evals\dev-bench.mjs"
$CheckpointDir = Join-Path $RepoRoot ".halo-agent"

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
        $json = & node --input-type=module -e "import { SCENARIOS } from './evals/scenarios.mjs'; console.log(JSON.stringify(SCENARIOS.map((s) => ({ name: s.name, tier: s.tier, language: s.language ?? 'js' }))));"
        if ($LASTEXITCODE -ne 0 -or -not $json) {
            throw "Could not load scenarios from evals/scenarios.mjs"
        }
        return @($json | ConvertFrom-Json)
    }
    finally {
        Pop-Location
    }
}

function Get-CheckpointLanguage {
    param($Checkpoint)

    if ($null -eq $Checkpoint) { return $null }
    if ($null -ne $Checkpoint.languageFilter) {
        $langs = @($Checkpoint.languageFilter | Where-Object { $_ })
        if ($langs.Count -gt 0) { return ($langs -join ",") }
    }
    $label = [string]$Checkpoint.selectionLabel
    if ($label -match '^language ([^,]+), ') {
        return $Matches[1]
    }
    return $null
}

function Get-BenchCheckpoints {
    if (-not (Test-Path $CheckpointDir)) { return @() }
    $items = @()
    foreach ($file in @(Get-ChildItem -Path $CheckpointDir -File -Filter "bench-checkpoint*.json" -ErrorAction SilentlyContinue)) {
        try {
            $data = Get-Content $file.FullName -Raw | ConvertFrom-Json
        }
        catch {
            continue
        }
        if (-not $data) { continue }
        $items += [pscustomobject]@{
            Path = $file.FullName
            Language = Get-CheckpointLanguage $data
            Data = $data
        }
    }
    return @($items)
}

function Get-BenchCheckpoint {
    param([string]$Language)

    $all = @(Get-BenchCheckpoints)
    if ($Language) {
        $normalized = Convert-BenchLanguage $Language
        $match = @(
            $all | Where-Object {
                $_.Language -and ($_.Language -eq $normalized -or $_.Language -eq $Language)
            }
        )
        if ($match.Count -ge 1) { return $match[0] }
        return $null
    }
    if ($all.Count -eq 1) { return $all[0] }
    return $null
}

function Reset-BenchCheckpoint {
    param([string]$Language)

    Push-Location $RepoRoot
    try {
        $resetArgs = @("--reset")
        if ($Language) {
            $resetArgs += @("--language", (Convert-BenchLanguage $Language))
        }
        & node $BenchScript @resetArgs
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

function Convert-BenchLanguage {
    param([string]$Value)

    switch ($Value.ToLowerInvariant()) {
        "js" { return "js" }
        "javascript" { return "js" }
        "python" { return "python" }
        "py" { return "python" }
        "csharp" { return "csharp" }
        "cs" { return "csharp" }
        default { throw "Unknown language '$Value'. Use js, python, or csharp." }
    }
}

function Show-LanguageMenu {
    Write-Host ""
    Write-Host "  1) JavaScript"
    Write-Host "  2) Python"
    Write-Host "  3) C#"
    Write-Host "  0) Back"
    Write-Host ""

    $choice = Read-MenuChoice -Prompt "Language" -ValidChoices @("0", "1", "2", "3")
    if ($choice -eq "0") { return $null }

    $language = switch ($choice) {
        "1" { "js" }
        "2" { "python" }
        "3" { "csharp" }
    }

    if ($language -eq "python") {
        $python = Get-Command python -ErrorAction SilentlyContinue
        $py = Get-Command py -ErrorAction SilentlyContinue
        if (-not $python -and -not $py) {
            Write-Host "python was not found on PATH. Python scenarios will be skipped unless you name them." -ForegroundColor Yellow
        }
    }
    if ($language -eq "csharp" -and -not (Get-Command dotnet -ErrorAction SilentlyContinue)) {
        Write-Host "dotnet was not found on PATH. C# scenarios will be skipped unless you name them." -ForegroundColor Yellow
    }

    return @{ Mode = "language"; Language = $language }
}

function Show-ScenarioMenu {
    param($Scenarios)

    Write-Host ""
    Write-Host "  A) All scenarios"
    for ($i = 0; $i -lt $Scenarios.Count; $i++) {
        $scenario = $Scenarios[$i]
        $num = $i + 1
        Write-Host ("  {0,2}) {1,-24} (tier {2}, {3})" -f $num, $scenario.Name, $scenario.Tier, $scenario.Language)
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
        "language" {
            if ($Flat) { $args.Add("--flat") }
        }
    }

    if ($Selection.Language) {
        $args.Add("--language")
        $args.Add($Selection.Language)
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

    $language = Get-CheckpointLanguage $Checkpoint
    $label = [string]$Checkpoint.selectionLabel
    if ($label -match '^language ([^,]+), (.+)$') {
        if (-not $language) { $language = $Matches[1] }
        $label = $Matches[2]
    }

    $selection = $null
    if ($label -match '^scenario (.+)$') {
        $selection = @{ Mode = "scenario"; Name = $Matches[1] }
    }
    elseif ($label -match '^tier ≤(\d+) \(flat\)$') {
        $selection = @{ Mode = "tier"; Tier = [int]$Matches[1]; Flat = $true }
    }
    elseif ($label -match '^tier ≤(\d+) \(progression\)$') {
        $selection = @{ Mode = "tier"; Tier = [int]$Matches[1] }
    }
    elseif ($label -eq "all scenarios (flat)") {
        $selection = @{ Mode = "all"; Flat = $true }
    }
    elseif ($label -eq "all scenarios (progression)") {
        $selection = @{ Mode = "all" }
    }

    if ($selection -and $language) {
        $selection.Language = $language
    }
    return $selection
}

function Format-ResumeHint {
    param($Checkpoints)

    if ($Checkpoints.Count -eq 0) { return "" }
    if ($Checkpoints.Count -eq 1) {
        $cp = $Checkpoints[0].Data
        $completed = @($cp.completedNames).Count
        $total = @($cp.scenarioNames).Count
        return " ($completed/$total done: $($cp.selectionLabel))"
    }

    $bits = foreach ($item in $Checkpoints) {
        $done = @($item.Data.completedNames).Count
        $total = @($item.Data.scenarioNames).Count
        $lang = if ($item.Language) { $item.Language } else { "all" }
        "${lang} $done/$total"
    }
    return " ($($bits -join '; '))"
}

function Show-ResumeMenu {
    param($Checkpoints)

    if ($Checkpoints.Count -eq 0) { return $null }
    if ($Checkpoints.Count -eq 1) {
        return Get-ResumeSelectionFromCheckpoint -Checkpoint $Checkpoints[0].Data
    }

    Write-Host ""
    Write-Host "Interrupted runs:"
    $valid = @("0")
    for ($i = 0; $i -lt $Checkpoints.Count; $i++) {
        $item = $Checkpoints[$i]
        $done = @($item.Data.completedNames).Count
        $total = @($item.Data.scenarioNames).Count
        $lang = if ($item.Language) { $item.Language } else { "all" }
        $num = $i + 1
        Write-Host ("  {0}) {1,-8} {2}/{3}  {4}" -f $num, $lang, $done, $total, $item.Data.selectionLabel)
        $valid += [string]$num
    }
    Write-Host "  0) Back"
    Write-Host ""

    $choice = Read-MenuChoice -Prompt "Resume" -ValidChoices $valid
    if ($choice -eq "0") { return $null }
    return Get-ResumeSelectionFromCheckpoint -Checkpoint $Checkpoints[[int]$choice - 1].Data
}

Test-NodeReady

if ($Reset) {
    Reset-BenchCheckpoint -Language $Language
    Write-Host "Bench checkpoint cleared." -ForegroundColor Green
    if (-not $Resume) {
        exit 0
    }
}

$scenarios = Get-ScenarioCatalog
$tiers = ($scenarios.Tier | Sort-Object -Unique)

if ($Resume) {
    $item = Get-BenchCheckpoint -Language $Language
    if (-not $item) {
        $all = @(Get-BenchCheckpoints)
        if ($Language) {
            Write-Host "No saved $Language bench progress to resume." -ForegroundColor Yellow
        }
        elseif ($all.Count -gt 1) {
            Write-Host "Multiple language checkpoints found. Resume one with -Language:" -ForegroundColor Yellow
            foreach ($cp in $all) {
                $done = @($cp.Data.completedNames).Count
                $total = @($cp.Data.scenarioNames).Count
                $lang = if ($cp.Language) { $cp.Language } else { "all" }
                Write-Host "  $lang  $done/$total  $($cp.Data.selectionLabel)"
            }
            Write-Host "Example: .\bin\bench.ps1 -Resume -Language csharp"
        }
        else {
            Write-Host "No saved bench progress to resume." -ForegroundColor Yellow
        }
        exit 1
    }
    $checkpoint = $item.Data
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

if ($Language) {
    $selection = @{ Mode = "language"; Language = (Convert-BenchLanguage $Language) }
    $benchArgs = Build-BenchArgs -Selection $selection
    Invoke-DevBench -BenchArgs $benchArgs
    exit $LASTEXITCODE
}

while ($true) {
    $checkpoints = @(Get-BenchCheckpoints)
    $resumeHint = Format-ResumeHint $checkpoints

    Write-Host ""
    Write-Host "=== halo-agent dev bench ===" -ForegroundColor Green
    Write-Host ""
    Write-Host "  1) Run all scenarios (tier progression)"
    Write-Host "  2) Run all scenarios (flat, no tier pauses)"
    Write-Host "  3) Run by tier"
    Write-Host "  4) Run by scenario"
    Write-Host "  5) Run by language"
    if ($checkpoints.Count -gt 0) {
        Write-Host "  6) Resume interrupted run$resumeHint" -ForegroundColor Cyan
        Write-Host "  7) Reset saved progress"
    }
    Write-Host "  0) Exit"
    Write-Host ""

    $validMain = @("0", "1", "2", "3", "4", "5")
    if ($checkpoints.Count -gt 0) { $validMain += @("6", "7") }
    $main = Read-MenuChoice -Prompt "Choice" -ValidChoices $validMain

    if ($main -eq "0") {
        exit 0
    }

    if ($main -eq "7") {
        Reset-BenchCheckpoint
        Write-Host "Bench checkpoint cleared." -ForegroundColor Green
        continue
    }

    $selection = $null
    $useResume = $false

    if ($main -eq "6") {
        $selection = Show-ResumeMenu -Checkpoints $checkpoints
        if (-not $selection) {
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
            "5" { $selection = Show-LanguageMenu }
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
