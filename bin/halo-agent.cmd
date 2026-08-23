@echo off
rem halo-agent launcher: validates Node.js, then forwards to the CLI.

where node >nul 2>nul
if errorlevel 1 (
    echo halo-agent needs Node.js 20 or newer, and 'node' was not found on PATH. 1>&2
    echo Install it with:  winget install OpenJS.NodeJS.LTS 1>&2
    echo or download it from https://nodejs.org - then rerun this script. 1>&2
    exit /b 10
)

node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 20 ? 0 : 1)"
if errorlevel 1 (
    echo halo-agent needs Node.js 20 or newer; run 'node -v' to see your version. 1>&2
    echo Update it with:  winget upgrade OpenJS.NodeJS.LTS   ^(or https://nodejs.org^) 1>&2
    exit /b 10
)

node "%~dp0..\src\cli.mjs" %*
exit /b %errorlevel%
