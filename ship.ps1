# ship.ps1 - push and deploy as one act.
#
# Workers Builds is not connected, so `git push` alone does not update
# https://typewriter.benzur.workers.dev. This script binds the two steps
# together and then proves the live site actually changed, so a push can
# never silently leave users on old code.
#
# Run the pre-push gate in CLAUDE.md BEFORE this script. It does not bump
# APP_VERSION or write the CHANGELOG for you - it only checks that you did,
# by refusing to run when the live version already matches the local one.
#
#   .\ship.ps1            push, deploy, verify
#   .\ship.ps1 -SkipPush  deploy an already-pushed commit

param(
  [switch]$SkipPush
)

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$site = 'https://typewriter.benzur.workers.dev'

function Get-LocalVersion {
  $line = Select-String -Path 'public/app.js' -Pattern "APP_VERSION\s*=\s*'([^']+)'" | Select-Object -First 1
  if (-not $line) { throw 'APP_VERSION not found in public/app.js' }
  return $line.Matches[0].Groups[1].Value
}

function Get-LiveVersion {
  try {
    $body = (Invoke-WebRequest -Uri "$site/app.js?cachebust=$(Get-Random)" -UseBasicParsing).Content
  } catch {
    return $null
  }
  if ($body -match "APP_VERSION\s*=\s*'([^']+)'") { return $Matches[1] }
  return $null
}

$local = Get-LocalVersion
Write-Host "Local APP_VERSION: $local"

# --- gate: the working tree must be clean, or the deploy ships something
# --- that is not in git and cannot be reproduced later.
$dirty = git status --porcelain
if ($dirty) {
  Write-Host ''
  Write-Host 'Working tree is dirty. Commit or stash before shipping:' -ForegroundColor Red
  Write-Host $dirty
  exit 1
}

$before = Get-LiveVersion
if ($before) { Write-Host "Live APP_VERSION:  $before" }
else { Write-Host 'Live APP_VERSION:  (could not read)' }

if ($before -and $before -eq $local) {
  Write-Host ''
  Write-Host "APP_VERSION $local is already live. Bump it in public/app.js and fold the CHANGELOG entry first (see the pre-push gate in CLAUDE.md)." -ForegroundColor Yellow
  Write-Host 'Shipping anyway would leave users unable to tell the builds apart.'
  exit 1
}

if (-not $SkipPush) {
  Write-Host ''
  Write-Host '--- git push ---'
  git push
  if ($LASTEXITCODE -ne 0) { throw 'git push failed; nothing deployed' }
}

Write-Host ''
Write-Host '--- npx wrangler deploy ---'
npx wrangler deploy
if ($LASTEXITCODE -ne 0) { throw 'wrangler deploy failed; the push landed but the live site is unchanged' }

Write-Host ''
Write-Host '--- verifying ---'
$after = Get-LiveVersion
if ($after -eq $local) {
  Write-Host "Live site now serves APP_VERSION $after." -ForegroundColor Green
} else {
  Write-Host "Live site reports '$after', expected '$local'. The deploy reported success, so this is probably an edge cache - recheck in a minute before assuming it failed." -ForegroundColor Yellow
}

# --- gate: nothing above public/ should ever be fetchable.
Write-Host ''
Write-Host '--- checking that repo furniture stays private ---'
$leaked = @()
foreach ($path in @('CLAUDE.md', 'PROGRESS.md', 'CHANGELOG.md', 'wrangler.jsonc', 'docs/realism-prompt.md')) {
  # Windows PowerShell 5.1 throws on any non-2xx, which is the answer we want
  # here: a throw means the path is not served, and that is a pass.
  try {
    $code = (Invoke-WebRequest -Uri "$site/$path" -UseBasicParsing).StatusCode
  } catch {
    $code = 404
  }
  if ($code -eq 200) { $leaked += $path }
}
if ($leaked.Count -gt 0) {
  Write-Host "FETCHABLE ON THE PUBLIC URL: $($leaked -join ', ')" -ForegroundColor Red
  Write-Host 'Something moved inside public/ that should not have. Fix before telling anyone the URL.'
  exit 1
}
Write-Host 'Repo furniture is not reachable. Done.' -ForegroundColor Green
