# dsh-tps-meter installer (DSH web profile)
#
# Registers this folder as a linked plugin of the web profile and inserts the
# loader row into the profile's cordis.patch.yml, which the config HMR applies
# live (no desktop restart needed).
#
#   pwsh -File install.ps1            # install / reinstall
#   pwsh -File install.ps1 -Remove    # uninstall (keeps backups)
#
param([switch]$Remove)

$ErrorActionPreference = 'Stop'
$project = $PSScriptRoot
$profileDir = Join-Path $env:USERPROFILE '.dsh\profiles\web'
$pkgFile = Join-Path $profileDir 'package.json'
$patchFile = Join-Path $profileDir 'cordis.patch.yml'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'

if (-not (Test-Path $pkgFile)) { throw "profile not found: $pkgFile" }
if (-not (Test-Path $patchFile)) { throw "patch file not found: $patchFile" }

$linkPath = ($project -replace '\\', '/')
$linkSpec = "dsh-tps-meter@link:$linkPath"

Copy-Item $pkgFile "$pkgFile.bak-tps-$stamp" -Force
Copy-Item $patchFile "$patchFile.bak-tps-$stamp" -Force

Push-Location $profileDir
try {
  if ($Remove) {
    & pnpm remove dsh-tps-meter
  } else {
    & pnpm add $linkSpec
  }
  if ($LASTEXITCODE -ne 0) { throw "pnpm exited with $LASTEXITCODE" }
} finally {
  Pop-Location
}

# --- cordis.patch.yml: add / drop the insert row ---------------------------
$lines = [System.Collections.Generic.List[string]](Get-Content $patchFile)

function Find-RowIndex([System.Collections.Generic.List[string]]$list) {
  for ($i = 0; $i -lt $list.Count; $i++) {
    if ($list[$i] -match 'dsh-tps-meter') { return $i }
  }
  return -1
}

if ($Remove) {
  $row = Find-RowIndex $lines
  if ($row -ge 0) {
    # the row is two lines (id + name) at 4/6 space indent; drop the pair
    $end = $row + 1
    while ($end -lt $lines.Count -and $lines[$end] -match '^\s{4,}') { $end++ }
    $lines.RemoveRange($row, $end - $row)
    [System.IO.File]::WriteAllLines($patchFile, $lines, (New-Object System.Text.UTF8Encoding($false)))
    Write-Output "patch: removed dsh-tps-meter row"
  } else {
    Write-Output "patch: no dsh-tps-meter row found"
  }
} else {
  if ((Find-RowIndex $lines) -ge 0) {
    Write-Output "patch: row already present, left untouched"
  } else {
    $insertAt = -1
    for ($i = 0; $i -lt $lines.Count; $i++) {
      if ($lines[$i] -match '^\s*-\s*insert:') { $insertAt = $i; break }
    }
    if ($insertAt -lt 0) {
      $lines.Add('- insert:')
      $lines.Add('    - id: dsh-tps-meter')
      $lines.Add('      name: dsh-tps-meter')
    } else {
      $end = $insertAt + 1
      while ($end -lt $lines.Count) {
        $line = $lines[$end]
        if ($line.Trim().Length -eq 0) { break }
        if ($line -notmatch '^\s{4,}') { break }
        $end++
      }
      $lines.Insert($end, '    - id: dsh-tps-meter')
      $lines.Insert($end + 1, '      name: dsh-tps-meter')
    }
    [System.IO.File]::WriteAllLines($patchFile, $lines, (New-Object System.Text.UTF8Encoding($false)))
    Write-Output "patch: inserted dsh-tps-meter row"
  }
}

Write-Output "profile: $profileDir"
Write-Output "link:    $linkSpec"
Write-Output "backups: *.bak-tps-$stamp"
