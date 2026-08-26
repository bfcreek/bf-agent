# Publish halo-agent release zip to R2 staging (no production promote).
#
# Usage:
#   .\scripts\release\publish-release.ps1
#   .\scripts\release\publish-release.ps1 -SkipTests
#   .\scripts\release\publish-release.ps1 -BumpPatch
#   .\scripts\release\publish-release.ps1 -DryRun
#
# After upload, verify staging then promote at:
#   https://www.halosoftworks.com/admin/releases

param(
    [switch] $SkipTests,
    [switch] $BumpPatch,
    [switch] $DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$PkgPath = Join-Path $RepoRoot 'package.json'

function Write-Step([string] $Message) {
    Write-Host ""
    Write-Host "-> $Message" -ForegroundColor Cyan
}

function Invoke-Checked {
    param(
        [string] $Label,
        [string] $FilePath,
        [string[]] $ArgumentList,
        [string] $WorkingDirectory = $RepoRoot
    )

    Write-Host "  $FilePath $($ArgumentList -join ' ')"
    if ($DryRun) { return }

    Push-Location $WorkingDirectory
    try {
        & $FilePath @ArgumentList
        if ($LASTEXITCODE -ne 0) {
            throw "$Label failed (exit $LASTEXITCODE)."
        }
    } finally {
        Pop-Location
    }
}

function Bump-PackagePatch {
    $pkg = Get-Content -Raw -Path $PkgPath | ConvertFrom-Json
    $parts = [string]$pkg.version -split '\.'
    if ($parts.Count -lt 3) {
        throw "package.json version must be semver (major.minor.patch): $($pkg.version)"
    }
    $patch = [int]$parts[2]
    $parts[2] = [string]($patch + 1)
    $pkg.version = $parts -join '.'
    $text = Get-Content -Raw -Path $PkgPath
    $text = $text -replace '"version"\s*:\s*"[^"]+"', ('"version": "' + $pkg.version + '"')
    Set-Content -Path $PkgPath -Value $text -NoNewline
    Write-Host "Bumped version to $($pkg.version)" -ForegroundColor Green
}

if ($BumpPatch) {
    Write-Step 'Bump package.json patch version'
    if (-not $DryRun) { Bump-PackagePatch }
}

if (-not $SkipTests) {
    Write-Step 'Run unit tests'
    Invoke-Checked -Label 'node --test' -FilePath 'node' -ArgumentList @('--test')
}

Write-Step 'Build release zip'
Invoke-Checked -Label 'build-release-zip' -FilePath 'node' -ArgumentList @(
    (Join-Path $RepoRoot 'scripts\release\build-release-zip.cjs')
)

Write-Step 'Stage latest.yml for R2 upload'
Invoke-Checked -Label 'stage-release-artifacts' -FilePath 'node' -ArgumentList @(
    (Join-Path $RepoRoot 'scripts\release\stage-release-artifacts.cjs')
)

Write-Step 'Upload to R2 staging/'
Invoke-Checked -Label 'upload-r2-release' -FilePath 'node' -ArgumentList @(
    (Join-Path $RepoRoot 'scripts\release\upload-r2-release.cjs')
)

$pkg = Get-Content -Raw -Path $PkgPath | ConvertFrom-Json
$version = [string]$pkg.version

Write-Host ""
Write-Host "halo-agent v$version uploaded to R2 staging/. Promote at https://www.halosoftworks.com/admin/releases" -ForegroundColor Green
