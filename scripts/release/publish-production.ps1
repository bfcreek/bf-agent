# Publish @bitfieldcreek/bf-agent to npm after production CDN promotion.
#
# Prerequisite: halo-site admin promote for the staging zip (staging → production on R2).
#
# Usage:
#   .\scripts\release\publish-production.ps1
#   .\scripts\release\publish-production.ps1 -DryRun
#
# Credentials: scripts/release/.env.release (NPM_TOKEN)

param(
    [switch] $DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$PublishNpm = Join-Path $RepoRoot 'scripts\release\publish-npm.cjs'
$Args = @($PublishNpm)
if ($DryRun) { $Args += '--dry-run' }

Write-Host ""
Write-Host "-> Verify production CDN + publish to npm" -ForegroundColor Cyan
Write-Host "  node $($Args -join ' ')"

Push-Location $RepoRoot
try {
    & node @Args
    if ($LASTEXITCODE -ne 0) {
        throw "npm publish failed (exit $LASTEXITCODE)."
    }
} finally {
    Pop-Location
}

if (-not $DryRun) {
    Write-Host ""
    Write-Host "Production npm publish complete." -ForegroundColor Green
}
