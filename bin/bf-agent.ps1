# bf-agent launcher: validates Node.js, then forwards to the CLI.
# Usage: .\bin\bf-agent.ps1 "your goal" [options]

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    [Console]::Error.WriteLine("Bitfield Ollama Agent needs Node.js 20 or newer, and 'node' was not found on PATH.")
    [Console]::Error.WriteLine("Install it with:  winget install OpenJS.NodeJS.LTS")
    [Console]::Error.WriteLine("or download it from https://nodejs.org - then rerun this script.")
    exit 10
}

node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 20 ? 0 : 1)"
if ($LASTEXITCODE -ne 0) {
    $found = node -v
    [Console]::Error.WriteLine("Bitfield Ollama Agent needs Node.js 20 or newer; found $found.")
    [Console]::Error.WriteLine("Update it with:  winget upgrade OpenJS.NodeJS.LTS   (or https://nodejs.org)")
    exit 10
}

& node "$PSScriptRoot\..\src\cli.mjs" @args
exit $LASTEXITCODE
