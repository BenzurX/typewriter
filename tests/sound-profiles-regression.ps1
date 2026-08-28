$source = Get-Content -Raw (Join-Path $PSScriptRoot '..\app.js')
$html = Get-Content -Raw (Join-Path $PSScriptRoot '..\index.html')

$keyRoute = $source -match 'function synthProfileKey' -and $source -match "profile\.staged\) \{ synthProfileKey\(profile\); return; \}"
$returnRoute = $source -match 'function synthProfileReturn' -and $source -match "profile\.staged\) \{ synthProfileReturn\(profile, t\); return; \}"
$keyFrequencies = [regex]::Matches($source, 'staged: true, keyF: ([0-9]+)') | ForEach-Object { $_.Groups[1].Value }
$zipFrequencies = [regex]::Matches($source, 'zipF: ([0-9]+)') | Select-Object -Skip 1 | ForEach-Object { $_.Groups[1].Value }
$waveforms = [regex]::Matches($source, "wave: '([^']+)'") | ForEach-Object { $_.Groups[1].Value }
$namedDefault = $html -match '<option value="classic">Soft Mechanical</option>'

$pass = $keyRoute -and $returnRoute -and
  (($keyFrequencies | Sort-Object -Unique).Count -eq 4) -and
  (($zipFrequencies | Sort-Object -Unique).Count -eq 4) -and
  (($waveforms | Sort-Object -Unique).Count -ge 2) -and
  $namedDefault

if (-not $pass) {
  Write-Error "FAIL: keyRoute=$keyRoute returnRoute=$returnRoute keyF=$($keyFrequencies -join ',') zipF=$($zipFrequencies -join ',') waves=$($waveforms -join ',') namedDefault=$namedDefault"
  exit 1
}

"PASS: four distinct staged key/return topologies; default=Soft Mechanical"
