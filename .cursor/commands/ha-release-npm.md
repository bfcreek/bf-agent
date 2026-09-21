# /ha-release-npm

Publish the current `package.json` version of **@bitfieldcreek/bf-agent** to npm.

This does **not** bump the version, build a zip, or upload to R2. Production CDN promotion must already be done at the admin releases page. The script checks that production `latest.yml` matches `package.json` and that this version is not already the npm latest, then runs `npm publish --access public`.

## Run

From the **halo-agent** repo root (PowerShell):

```powershell
.\scripts\commands\ha-release-npm.ps1
```

Optional:

```powershell
.\scripts\commands\ha-release-npm.ps1 -DryRun
```

| Flag | Meaning |
| --- | --- |
| `-DryRun` | Verify readiness and run `npm publish --dry-run`; do not publish |

Underlying pipeline (`publish-production.ps1`):

1. Read `package.json` name and version
2. Fetch production `latest.yml` and require the same version
3. Refuse if that version is already npm latest
4. `npm publish --access public` using `NPM_TOKEN`

## After success

Report to the user:

- Published package and version (`@bitfieldcreek/bf-agent` at the `package.json` version)
- Install: `npm install -g @bitfieldcreek/bf-agent`

Do **not** commit unless the user explicitly asks.

## Prerequisites

| Need | Notes |
| --- | --- |
| Node.js 20+ | `node` on PATH |
| Production promote | Staging zip already promoted at https://www.halosoftworks.com/admin/releases so production `latest.yml` matches `package.json` |
| `scripts/release/.env.release` | `NPM_TOKEN` (npm Automation token; see `.env.release.example`) |

On failure, stop and report the failing step; do not retry publish.

## Related

- Staging zip (bump, test, upload): `/ha-release`
- Direct script: `.\scripts\release\publish-production.ps1`
