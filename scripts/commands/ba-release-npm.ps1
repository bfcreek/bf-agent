# /ba-release-npm - publish the current package version to npm and create a GitHub release.
#
# Prerequisite: production CDN already matches package.json (admin promote).
#
# Usage (from repo root):
#   .\scripts\commands\ha-release-npm.ps1
#   .\scripts\commands\ha-release-npm.ps1 -DryRun

param(
    [switch] $DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$PublishScript = Join-Path $RepoRoot 'scripts\release\publish-production.ps1'

if (-not (Test-Path $PublishScript)) {
    throw "Missing npm publisher: $PublishScript"
}

Write-Host "bf-agent /ba-release-npm - verify production CDN, GitHub release, publish to npm" -ForegroundColor Cyan
Write-Host ""

$argsList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $PublishScript)
if ($DryRun) { $argsList += '-DryRun' }

& powershell @argsList
if ($LASTEXITCODE -ne 0) {
    throw "/ha-release-npm failed (exit $LASTEXITCODE)."
}
