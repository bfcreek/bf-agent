# Start Terminal-Bench with recognized-bench defaults (evals/recognized/config.json).
# Usage: .\bin\bench-tb.ps1
#        .\bin\bench-tb.ps1 -Check
#        .\bin\bench-tb.ps1 -SkipJudge
#        .\bin\bench-tb.ps1 -Include openssl-selfsigned-cert
#        .\bin\bench-tb.ps1 -FromJob path\to\harbor\job
#        .\bin\bench-tb.ps1 -DryRun

param(
    [switch]$Check,
    [switch]$SkipJudge,
    [switch]$List,
    [switch]$DryRun,
    [string]$Dataset,
    [string]$Model,
    [string]$Include,
    [string]$FromJob,
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$ExtraArgs
)

$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$RunScript = Join-Path $RepoRoot "evals\recognized\run.mjs"
$ConfigPath = Join-Path $RepoRoot "evals\recognized\config.json"

function Test-NodeReady {
    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) {
        [Console]::Error.WriteLine("Terminal-Bench needs Node.js 20 or newer, and 'node' was not found on PATH.")
        [Console]::Error.WriteLine("Install it with:  winget install OpenJS.NodeJS.LTS")
        exit 10
    }

    & node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 20 ? 0 : 1)"
    if ($LASTEXITCODE -ne 0) {
        $found = & node -v
        [Console]::Error.WriteLine("Terminal-Bench needs Node.js 20 or newer; found $found.")
        exit 10
    }
}

function Get-TbDefaults {
    if (-not (Test-Path $ConfigPath)) {
        return [pscustomobject]@{
            dataset = "2.1"
            model = "auto"
            skipJudge = $false
            judgeModel = "auto"
        }
    }
    return Get-Content $ConfigPath -Raw | ConvertFrom-Json
}

Test-NodeReady

$defaults = Get-TbDefaults
$dataset = if ($Dataset) { $Dataset } else { $defaults.dataset }
$model = if ($Model) { $Model } else { $defaults.model }

$argsList = [System.Collections.Generic.List[string]]::new()
$argsList.Add("terminal-bench")

if ($List) {
    $argsList.Clear()
    $argsList.Add("--list")
}
elseif ($Check) {
    $argsList.Add("--check")
}
else {
    $argsList.Add("--dataset")
    $argsList.Add([string]$dataset)
    $argsList.Add("--model")
    $argsList.Add([string]$model)
    if ($SkipJudge) { $argsList.Add("--skip-judge") }
    if ($DryRun) { $argsList.Add("--dry-run") }
    if ($Include) {
        $argsList.Add("--include")
        $argsList.Add($Include)
    }
    if ($FromJob) {
        $argsList.Add("--from-job")
        $argsList.Add($FromJob)
    }
}

if ($ExtraArgs) { $argsList.AddRange($ExtraArgs) }

if (-not $List -and -not $Check) {
    $judge = if ($SkipJudge -or $defaults.skipJudge) { "Harbor tests only" } else { "Harbor tests + Cursor judge ($($defaults.judgeModel))" }
    Write-Host "Starting Terminal-Bench $dataset with halo-agent defaults" -ForegroundColor Cyan
    Write-Host "  model:  $model"
    Write-Host "  grade:  $judge"
    Write-Host "  needs:  Docker, Harbor, Ollama (host.docker.internal)"
    Write-Host ""
}

Write-Host "Running: node evals/recognized/run.mjs $($argsList -join ' ')" -ForegroundColor Cyan
Write-Host ""

Push-Location $RepoRoot
try {
    & node $RunScript @argsList
    exit $LASTEXITCODE
}
finally {
    Pop-Location
}
