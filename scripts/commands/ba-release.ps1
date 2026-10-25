# /ha-release - bump patch, test, build, upload to R2 staging.
#
# Usage (from repo root):
#   .\scripts\commands\ha-release.ps1
#   .\scripts\commands\ha-release.ps1 -SkipTests
#   .\scripts\commands\ha-release.ps1 -DryRun

param(
    [switch] $SkipTests,
    [switch] $DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$PublishScript = Join-Path $RepoRoot 'scripts\release\publish-release.ps1'

if (-not (Test-Path $PublishScript)) {
    throw "Missing release publisher: $PublishScript"
}

Write-Host "bf-agent /ha-release - bump patch, test, build, upload staging" -ForegroundColor Cyan
Write-Host ""

$argsList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $PublishScript, '-BumpPatch')
if ($SkipTests) { $argsList += '-SkipTests' }
if ($DryRun) { $argsList += '-DryRun' }

& powershell @argsList
if ($LASTEXITCODE -ne 0) {
    throw "/ha-release failed (exit $LASTEXITCODE)."
}
