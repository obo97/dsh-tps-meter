# ============================================================================
# dsh-tps-meter installer (DSH web profile)
# ============================================================================
# Registers this folder as a linked plugin of the web profile and lists it in
# `dsh.profile.bundles` -- the layer DSH itself manages for a package that
# ships its own patch (this package declares `dsh.bundle.patch`, see its
# cordis.patch.yml).
#
# Why bundles and not a hand-written row in the profile's cordis.patch.yml:
# DSH reconciles `dsh.profile.bundles` against the installed dependencies on
# every `dsh plugin ...` run, so a bundle-declaring package that is ALSO
# hand-listed in the profile patch gets registered twice. Deleting the plugin
# then clears one registration and leaves the other dangling, and DSH refuses
# to start ("cannot resolve profile bundle ..." -> `plugin tree failed to
# load`, so the process exits before it ever listens). One registration, in
# the layer DSH owns, is the only layout that survives an uninstall.
#
#   pwsh -File install.ps1                 # install / reinstall
#   pwsh -File install.ps1 -Remove         # uninstall
#
# The uninstall is idempotent and also repairs a profile that is already
# broken (a dangling bundle entry or dangling patch row left by an older
# install), so it doubles as the recovery path when DSH no longer starts.
#
#   -ProfileDir <path>   override the profile directory (default: the web profile)
#   -SkipPnpm            edit the profile config only, do not run pnpm (used by tests)
# ============================================================================
param(
  [switch]$Remove,
  [string]$ProfileDir,
  [switch]$SkipPnpm
)

$ErrorActionPreference = 'Stop'

$packageName = 'dsh-tps-meter'
$project = $PSScriptRoot
if (-not $project) { $project = Split-Path -Parent $MyInvocation.MyCommand.Path }
if (-not $ProfileDir) { $ProfileDir = Join-Path $env:USERPROFILE '.dsh\profiles\web' }
$profileDir = $ProfileDir
$pkgFile = Join-Path $profileDir 'package.json'
$patchFile = Join-Path $profileDir 'cordis.patch.yml'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$pnpmExit = 0

if (-not (Test-Path $pkgFile)) { throw "profile not found: $pkgFile" }
if (-not (Test-Path $patchFile)) { throw "patch file not found: $patchFile" }

$linkSpec = "$packageName@link:$($project -replace '\\', '/')"

# --- line-level text helpers ------------------------------------------------
# Both files are edited line by line (never re-serialized), so the user's
# formatting, key order, newline style and BOM-free encoding all survive.

# @returns a document: Lines (array), Nl (newline style), FinalNewline (bool).
function Read-Doc([string]$path) {
  $raw = [System.IO.File]::ReadAllText($path)
  $nl = "`n"
  if ($raw.Contains("`r`n")) { $nl = "`r`n" }
  $body = $raw.Replace("`r`n", "`n")
  $final = $false
  if ($body.EndsWith("`n")) {
    $final = $true
    $body = $body.Substring(0, $body.Length - 1)
  }
  $lines = @()
  if ($body.Length -gt 0) { $lines = @($body -split "`n") }
  return @{ Lines = $lines; Nl = $nl; FinalNewline = $final }
}

function Write-Doc([string]$path, $doc) {
  $text = ($doc.Lines -join $doc.Nl)
  if ($doc.FinalNewline) { $text = $text + $doc.Nl }
  [System.IO.File]::WriteAllText($path, $text, (New-Object System.Text.UTF8Encoding($false)))
}

function Assert-ValidJson([string]$path) {
  $text = [System.IO.File]::ReadAllText($path)
  try {
    $null = ConvertFrom-Json -InputObject $text
  } catch {
    throw "edited package.json is not valid JSON (restore it from the .bak-tps-* backup): $($_.Exception.Message)"
  }
}

# Drop lines [$start, $endExclusive). Slicing goes through this helper because
# PowerShell's `$a[0..-1]` is not an empty range (0 and -1 are read as two
# separate indices), which would corrupt the file at the array boundaries.
function Remove-LineRange([string[]]$lines, [int]$start, [int]$endExclusive) {
  $kept = @()
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($i -ge $start -and $i -lt $endExclusive) { continue }
    $kept += $lines[$i]
  }
  return $kept
}

function Get-Indent([string]$line) {
  return ($line.Length - $line.TrimStart().Length)
}

# Locate the container (`{` or `[`) that follows `"<key>":`, plus its closing
# line -- matched by bracket kind and indent, so a `}` can never be mistaken
# for the `]` of a nested array.
# @returns @{ Open; Close; OpenChar } or $null when the file is not in the
# expected expanded form (callers refuse to edit rather than guess).
function Find-Block([string[]]$lines, [string]$key) {
  $open = -1
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match ('^\s*"' + [regex]::Escape($key) + '"\s*:\s*[\{\[]\s*$')) { $open = $i; break }
  }
  if ($open -lt 0) { return $null }
  $indent = Get-Indent $lines[$open]
  $openChar = '['
  if ($lines[$open].TrimEnd().EndsWith('{')) { $openChar = '{' }
  $closeChar = '}'
  if ($openChar -eq '[') { $closeChar = ']' }
  $closeRe = '^' + [regex]::Escape($closeChar) + '\s*,?\s*$'
  for ($i = $open + 1; $i -lt $lines.Count; $i++) {
    if ($lines[$i].Trim().Length -eq 0) { continue }
    $cur = Get-Indent $lines[$i]
    if ($cur -eq $indent -and $lines[$i].Trim() -match $closeRe) {
      return @{ Open = $open; Close = $i; OpenChar = $openChar }
    }
    if ($cur -lt $indent) { break }
  }
  return $null
}

# Line index of a `"<name>"` array entry or `"<name>": value` property inside
# the block, or -1.
function Find-Entry([string[]]$lines, $block, [string]$name) {
  $re = '^\s*"' + [regex]::Escape($name) + '"\s*([:,].*)?$'
  for ($i = $block.Open + 1; $i -lt $block.Close; $i++) {
    if ($lines[$i] -match $re) { return $i }
  }
  return -1
}

# Drop one entry line while keeping the JSON comma-separated: a removed last
# entry carries no trailing comma, so the previous entry's comma is trimmed.
function Remove-EntryLine($list, [int]$index) {
  $hasComma = $list[$index].TrimEnd().EndsWith(',')
  $list.RemoveAt($index)
  if ($hasComma) { return }
  for ($i = $index - 1; $i -ge 0; $i--) {
    if ($list[$i].Trim().Length -eq 0) { continue }
    $prev = $list[$i].TrimEnd()
    if ($prev.EndsWith(',')) { $list[$i] = $prev.Substring(0, $prev.Length - 1) }
    break
  }
}

# Append an array entry, matching the existing entries' indentation. The new
# entry becomes the last one, so it carries no trailing comma while the entry
# it displaced gets one.
function Add-EntryLine($list, $block, [string]$entryText) {
  $last = -1
  for ($i = $block.Close - 1; $i -gt $block.Open; $i--) {
    if ($list[$i].Trim().Length -gt 0) { $last = $i; break }
  }
  if ($last -lt 0) {
    $indent = (Get-Indent $list[$block.Open]) + 2
    $list.Insert($block.Open + 1, ((' ' * $indent) + $entryText))
    return
  }
  $indent = Get-Indent $list[$last]
  $prev = $list[$last].TrimEnd()
  if (-not $prev.EndsWith(',')) { $list[$last] = $prev + ',' }
  $list.Insert($last + 1, ((' ' * $indent) + $entryText))
}

# --- cordis.patch.yml helpers ----------------------------------------------
# A plugin row is `- id: <name>` at some indent plus the deeper-indented lines
# belonging to it (`name:`, `config:`, its children). The row ends at the
# first line not indented deeper than the id line, so sibling rows survive.

function Find-PatchRowStart([string[]]$lines, [string]$name) {
  $re = '^\s*-\s*id:\s*' + [regex]::Escape($name) + '\s*$'
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match $re) { return $i }
  }
  return -1
}

function Get-PatchRowEnd([string[]]$lines, [int]$start) {
  $indent = Get-Indent $lines[$start]
  $end = $start + 1
  while ($end -lt $lines.Count) {
    if ($lines[$end].Trim().Length -eq 0) { break }
    if ((Get-Indent $lines[$end]) -le $indent) { break }
    $end = $end + 1
  }
  return $end
}

# --- profile state ----------------------------------------------------------

function Get-DocState([string]$path) {
  $doc = Read-Doc $path
  $list = [System.Collections.Generic.List[string]]::new()
  foreach ($line in $doc.Lines) { $list.Add($line) }
  return @{ Doc = $doc; List = $list }
}

function Save-DocState([string]$path, $state) {
  $state.Doc.Lines = $state.List.ToArray()
  Write-Doc $path $state.Doc
}

# Remove `"<name>"` from the `<key>` container of a JSON file.
# @returns $true when a line was removed.
function Remove-JsonEntry([string]$path, [string]$key, [string]$name) {
  $state = Get-DocState $path
  $block = Find-Block $state.Doc.Lines $key
  if ($block -eq $null) { throw "cannot find the `"$key`" block in $path" }
  $entry = Find-Entry $state.Doc.Lines $block $name
  if ($entry -lt 0) { return $false }
  Remove-EntryLine $state.List $entry
  Save-DocState $path $state
  Assert-ValidJson $path
  return $true
}

# Remove the `- id: <name>` row (and its continuation lines) from the patch.
# @returns $true when a row was removed.
function Remove-PatchRow([string]$path, [string]$name) {
  $doc = Read-Doc $path
  $row = Find-PatchRowStart $doc.Lines $name
  if ($row -lt 0) { return $false }
  $end = Get-PatchRowEnd $doc.Lines $row
  $doc.Lines = Remove-LineRange $doc.Lines $row $end
  Write-Doc $path $doc
  return $true
}

# Which places still reference the plugin -- the list that decides whether DSH
# can start again.
function Get-ProfileReferences([string]$pkgPath, [string]$patchPath, [string]$name) {
  $found = @()
  $doc = Read-Doc $pkgPath
  $block = Find-Block $doc.Lines 'bundles'
  if ($block -ne $null -and (Find-Entry $doc.Lines $block $name) -ge 0) { $found += 'dsh.profile.bundles' }
  $block = Find-Block $doc.Lines 'dependencies'
  if ($block -ne $null -and (Find-Entry $doc.Lines $block $name) -ge 0) { $found += 'dependencies' }
  $patch = Read-Doc $patchPath
  if ((Find-PatchRowStart $patch.Lines $name) -ge 0) { $found += 'cordis.patch.yml' }
  return $found
}

# --- main -------------------------------------------------------------------

Write-Output "profile: $profileDir"

# Back up before anything is touched, pnpm included.
Copy-Item $pkgFile "$pkgFile.bak-tps-$stamp" -Force
Copy-Item $patchFile "$patchFile.bak-tps-$stamp" -Force

if (-not $SkipPnpm) {
  Push-Location $profileDir
  try {
    if ($Remove) { & pnpm remove $packageName } else { & pnpm add $linkSpec }
    $pnpmExit = $LASTEXITCODE
  } finally {
    Pop-Location
  }
}

if ($Remove) {
  # Registration first: clearing it is what makes a broken profile startable
  # again, so it must not depend on pnpm having succeeded.
  if (Remove-JsonEntry $pkgFile 'bundles' $packageName) {
    Write-Output 'bundles: entry removed'
  } else {
    Write-Output 'bundles: no entry found'
  }
  if (Remove-PatchRow $patchFile $packageName) {
    Write-Output 'patch:   legacy insert row removed'
  } else {
    Write-Output 'patch:   no insert row found'
  }
  if ($pnpmExit -ne 0) {
    Write-Output "WARNING: pnpm remove exited with $pnpmExit"
  }
  # pnpm normally drops the dependency; when it is unavailable or failed, do
  # it by hand so no reference is left behind.
  if (Remove-JsonEntry $pkgFile 'dependencies' $packageName) {
    Write-Output 'deps:    dependency entry removed'
  }
  Write-Output "link:    $linkSpec"
  Write-Output "backups: *.bak-tps-$stamp"

  $left = @(Get-ProfileReferences $pkgFile $patchFile $packageName)
  if ($left.Count -eq 0) {
    Write-Output 'self-check: no dsh-tps-meter reference left in the profile'
    Write-Output 'Next: start DSH again.'
  } else {
    Write-Output "self-check: still referenced by $($left -join ', ') -- remove that manually"
    exit 1
  }
} else {
  if ($pnpmExit -ne 0) { throw "pnpm add exited with $pnpmExit; the profile was not modified" }

  $state = Get-DocState $pkgFile
  $block = Find-Block $state.Doc.Lines 'bundles'
  if ($block -eq $null) { throw "cannot find the `"bundles`" block in $pkgFile" }
  if ((Find-Entry $state.Doc.Lines $block $packageName) -lt 0) {
    Add-EntryLine $state.List $block ("`"$packageName`"")
    Save-DocState $pkgFile $state
    Assert-ValidJson $pkgFile
    Write-Output 'bundles: entry added'
  } else {
    Write-Output 'bundles: entry already present'
  }

  # Migrate a profile installed by an older version of this script: a hand
  # written patch row plus the bundle entry would register the plugin twice.
  if (Remove-PatchRow $patchFile $packageName) {
    Write-Output 'patch:   legacy insert row removed (registration moved to dsh.profile.bundles)'
  }

  Write-Output "link:    $linkSpec"
  Write-Output "backups: *.bak-tps-$stamp"

  $left = @(Get-ProfileReferences $pkgFile $patchFile $packageName)
  Write-Output "self-check: registered in $($left -join ', ')"
  if ($left -notcontains 'dsh.profile.bundles') { Write-Output 'WARNING: the bundle registration is missing, the plugin will not load' }
  if ($left -contains 'cordis.patch.yml') { Write-Output 'WARNING: a patch row is still present, the plugin would load twice' }
  Write-Output 'Next: restart DSH to activate the plugin (bundle layers load at startup).'
  exit 0
}
