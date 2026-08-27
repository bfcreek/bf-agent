# /ha-release

Bump the package patch version, run tests, build the release zip, and upload it to **R2 staging**.

This does **not** promote to production or publish to npm. After staging succeeds, production promote is manual at the admin releases page, then `.\scripts\release\publish-production.ps1`.

## Run

From the **halo-agent** repo root (PowerShell):

```powershell
.\scripts\commands\ha-release.ps1
```

Optional:

```powershell
.\scripts\commands\ha-release.ps1 -SkipTests
.\scripts\commands\ha-release.ps1 -DryRun
```

| Flag | Meaning |
| --- | --- |
| `-SkipTests` | Skip `node --test` (not recommended) |
| `-DryRun` | Print steps only; do not bump, test, build, or upload |

Underlying pipeline (`publish-release.ps1 -BumpPatch`):

1. Bump `package.json` patch version
2. Run unit tests (`node --test`)
3. Build release zip
4. Stage `latest.yml`
5. Upload to R2 `staging/`

## After success

Report to the user:

- New version from `package.json`
- Staging manifest: https://halo-agent-releases.halosoftworks.com/staging/latest.yml
- Next steps: promote at https://www.halosoftworks.com/admin/releases, then `.\scripts\release\publish-production.ps1` for npm

Do **not** commit the version bump unless the user explicitly asks.

## Prerequisites

| Need | Notes |
| --- | --- |
| Node.js 20+ | `node` on PATH |
| `scripts/release/.env.release` | `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` (see `.env.release.example`) |

On failure, stop and report the failing step; do not continue to upload.

## Related

- Staging only (no bump): `.\scripts\release\publish-release.ps1`
- Production npm after admin promote: `.\scripts\release\publish-production.ps1`
