# Local development bench — host Node + host Ollama, no Harbor.
# Cursor CLI judges each scenario. Output: ../halo-agent-benchmark/ and bench-latest.md
#
# Usage: .\bin\bench-local.ps1
#        .\bin\bench-local.ps1 -SkipJudge
#        .\bin\bench-local.ps1 -Tier 2
#        .\bin\bench-local.ps1 -Scenario greet-module
#        .\bin\bench-local.ps1 -Language csharp
#
# Interactive menu: .\bin\bench.ps1
# Terminal-Bench (Harbor/Docker): .\bin\bench-tb.ps1
# Random 5-task sample: .\bin\bench-tb-mini.ps1

param(
    [switch]$SkipJudge,
    [switch]$KeepWorkspace,
    [switch]$Flat,
    [switch]$Resume,
    [switch]$Reset,
    [int]$Tier,
    [string]$Scenario,
    [ValidateSet("js", "javascript", "python", "py", "csharp", "cs")]
    [string]$Language,
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$ExtraArgs
)

$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$BenchScript = Join-Path $RepoRoot "evals\dev-bench.mjs"
$ConfigPath = Join-Path $RepoRoot "evals\bench.config.json"

function Test-NodeReady {
    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) {
        [Console]::Error.WriteLine("The local bench needs Node.js 20 or newer, and 'node' was not found on PATH.")
        [Console]::Error.WriteLine("Install it with:  winget install OpenJS.NodeJS.LTS")
        exit 10
    }

    & node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 20 ? 0 : 1)"
    if ($LASTEXITCODE -ne 0) {
        $found = & node -v
        [Console]::Error.WriteLine("The local bench needs Node.js 20 or newer; found $found.")
        exit 10
    }
}

function Get-LocalDefaults {
    if (-not (Test-Path $ConfigPath)) {
        return [pscustomobject]@{
            models = @("auto")
            judgeModel = "auto"
            skipJudge = $false
        }
    }
    return Get-Content $ConfigPath -Raw | ConvertFrom-Json
}

Test-NodeReady

$defaults = Get-LocalDefaults
$argsList = [System.Collections.Generic.List[string]]::new()

if ($Reset) { $argsList.Add("--reset") }
if ($Resume) { $argsList.Add("--resume") }
if ($SkipJudge) { $argsList.Add("--skip-judge") }
if ($KeepWorkspace) { $argsList.Add("--keep-workspace") }
if ($Flat) { $argsList.Add("--flat") }
if ($PSBoundParameters.ContainsKey("Tier")) {
    $argsList.Add("--tier")
    $argsList.Add([string]$Tier)
}
if ($Scenario) {
    $argsList.Add("--scenario")
    $argsList.Add($Scenario)
}
if ($Language) {
    $argsList.Add("--language")
    $argsList.Add($Language)
}
if ($ExtraArgs) { $argsList.AddRange($ExtraArgs) }

$modelList = @($defaults.models) -join ", "
$judge = if ($SkipJudge -or $defaults.skipJudge) { "precheck/integrity only" } else { "Cursor CLI ($($defaults.judgeModel))" }

Write-Host "Starting local development bench (no Harbor, no extra Compose)" -ForegroundColor Cyan
Write-Host "  model:  $modelList"
Write-Host "  grade:  $judge"
Write-Host "  needs:  Ollama on the host, Cursor CLI unless -SkipJudge"
Write-Host "  out:    ../halo-agent-benchmark/  and  bench-latest.md"
Write-Host ""
Write-Host "Running: node evals/dev-bench.mjs $($argsList -join ' ')" -ForegroundColor Cyan
Write-Host ""

Push-Location $RepoRoot
try {
    & node $BenchScript @argsList
    exit $LASTEXITCODE
}
finally {
    Pop-Location
}
