// The helper runs outside the application folder so Windows can replace it.
// Paths are supplied as JSON data, never embedded in shell command text.
export const UPDATE_HELPER = String.raw`param(
  [Parameter(Mandatory=$true)][string]$PlanPath,
  [ValidateSet('prepare','install')][string]$Mode='prepare',
  [ValidateRange(1,180)][int]$HealthSeconds=45
)
$ErrorActionPreference='Stop'
[Console]::WriteLine('helper:begin')
Add-Type -AssemblyName System.IO.Compression.FileSystem
$plan = [System.IO.File]::ReadAllText($PlanPath) | ConvertFrom-Json
function Full([string]$value) { return [System.IO.Path]::GetFullPath($value).TrimEnd('\') }
function Equal([string]$a,[string]$b) { return [string]::Equals((Full $a),(Full $b),[System.StringComparison]::OrdinalIgnoreCase) }
if ($plan.id -notmatch '^[a-f0-9]{32}$') { throw 'Invalid update id' }
$target = Full $plan.target
$parent = [System.IO.Path]::GetDirectoryName($target)
$work = Full $plan.work
$backup = Join-Path $parent ('.hongyi-backup-' + $plan.id)
$fresh = Join-Path $work 'new'
$failed = Join-Path $work 'failed'
if (!(Equal $work (Join-Path $parent ('.hongyi-update-' + $plan.id)))) { throw 'Unsafe staging directory' }
if (!$parent -or (Equal $target ([System.IO.Path]::GetPathRoot($target)))) { throw 'Unsafe installation directory' }
if ($plan.exe -ne [System.IO.Path]::GetFileName($plan.exe) -or $plan.exe -notmatch '\.exe$') { throw 'Invalid executable name' }
$oldExe = Join-Path $target $plan.exe
$job = [System.IO.Path]::GetDirectoryName((Full $PlanPath))
if ([System.IO.Path]::GetFileName($job) -ne $plan.id) { throw 'Invalid job directory' }
if ((Full $job).StartsWith($target + '\',[System.StringComparison]::OrdinalIgnoreCase)) { throw 'Update data cannot live inside the app directory' }
$receipt = Join-Path $job 'result.json'
function Receipt([string]$status,[string]$message) {
  @{status=$status;message=$message;version=$plan.version;backup=$backup} | ConvertTo-Json | Set-Content -LiteralPath $receipt -Encoding UTF8
}
function Retry([scriptblock]$action) {
  for ($attempt=0; $attempt -lt 30; $attempt++) {
    try { & $action; return } catch { if ($attempt -eq 29) { throw }; Start-Sleep -Milliseconds 300 }
  }
}
function LaunchApp([string]$arguments) {
  $startInfo=New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName=$oldExe
  $startInfo.WorkingDirectory=$target
  $startInfo.Arguments=$arguments
  $startInfo.UseShellExecute=$false
  $startInfo.CreateNoWindow=$true
  $startInfo.WindowStyle=[System.Diagnostics.ProcessWindowStyle]::Hidden
  return [System.Diagnostics.Process]::Start($startInfo)
}
function VerifyArchive {
  $archive = Get-Item -LiteralPath $plan.archive
  $algorithm=[System.Security.Cryptography.SHA256]::Create()
  $stream=[System.IO.File]::OpenRead($plan.archive)
  try { $actual=[System.BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-','').ToLowerInvariant() } finally { $stream.Dispose(); $algorithm.Dispose() }
  if ($archive.Length -ne $plan.size -or $actual -ne $plan.sha256) { throw 'Update archive checksum mismatch' }
}
function ExtractPackage {
  [Console]::WriteLine('helper:verify')
  VerifyArchive
  if (Test-Path -LiteralPath $fresh) { throw 'Staging directory already exists' }
  [System.IO.Directory]::CreateDirectory($fresh) | Out-Null
  $zip = [System.IO.Compression.ZipFile]::OpenRead($plan.archive)
  [Console]::WriteLine('helper:extract')
  try {
    if ($zip.Entries.Count -gt 15000) { throw 'Too many archive entries' }
    $paths = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
    [long]$total=0
    foreach ($entry in $zip.Entries) {
      $name=$entry.FullName.Replace('/','\')
      $segments=$name.Split('\')
      if ($name.StartsWith('\') -or $name.Contains(':') -or $segments -contains '..' -or $segments -contains '.' -or $name.Contains([char]0)) { throw 'Unsafe archive path' }
      foreach ($part in $segments) {
        if ($part -and ($part -match '[ .]$' -or $part -match '^(?i:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)')) { throw 'Reserved archive path' }
      }
      $out = Full (Join-Path $fresh $name)
      if (!$out.StartsWith((Full $fresh)+'\',[System.StringComparison]::OrdinalIgnoreCase)) { throw 'Archive escapes staging directory' }
      if (($entry.ExternalAttributes -band 1024) -ne 0 -or (($entry.ExternalAttributes -shr 16) -band 61440) -eq 40960) { throw 'Archive links are not allowed' }
      if (!$paths.Add($out)) { throw 'Duplicate archive path' }
      $total += $entry.Length
      if ($total -gt 1572864000 -or $entry.Length -gt 536870912) { throw 'Unpacked update is too large' }
      if ($name.EndsWith('\')) { [System.IO.Directory]::CreateDirectory($out) | Out-Null; continue }
      [System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($out)) | Out-Null
      $inputStream=$entry.Open()
      try { $outputStream=[System.IO.File]::Create($out); try { $inputStream.CopyTo($outputStream) } finally { $outputStream.Dispose() } } finally { $inputStream.Dispose() }
    }
  } finally { $zip.Dispose() }
  foreach ($file in @($plan.exe,'resources\app.asar','chrome_100_percent.pak','icudtl.dat')) {
    if (!(Test-Path -LiteralPath (Join-Path $fresh $file) -PathType Leaf)) { throw 'Not a complete portable application' }
  }
}
if ($Mode -eq 'prepare') {
  try { ExtractPackage; [Console]::WriteLine('helper:prepared'); Receipt 'prepared' 'Update package prepared'; exit 0 }
  catch { Receipt 'failed' $_.Exception.Message; throw }
}
$movedOld=$false
$movedNew=$false
$started=$null
$stage='verify'
try {
  VerifyArchive
  if (!(Test-Path -LiteralPath (Join-Path $fresh $plan.exe))) { throw 'Prepared application is missing' }
  $oldProcess=Get-Process -Id $plan.oldPid -ErrorAction SilentlyContinue
  if ($oldProcess -and !(Equal $oldProcess.Path $oldExe)) { throw 'Update process does not match the old application' }
  @{id=$plan.id} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $job 'helper-ready.json') -Encoding UTF8
  if ($oldProcess -and !$oldProcess.WaitForExit(90000)) { throw 'Old application did not exit; update canceled' }
  # Rebuild from the verified archive after exit; staging cannot be modified
  # between preparation and replacement without being checked again.
  if (!(Equal $fresh (Join-Path $work 'new'))) { throw 'Unsafe cleanup target' }
  $stage='extract'
  Remove-Item -LiteralPath $fresh -Recurse -Force
  ExtractPackage
  $stage='backup'
  Retry { [System.IO.Directory]::Move($target,$backup) }; $movedOld=$true
  $stage='replace'
  Retry { [System.IO.Directory]::Move($fresh,$target) }; $movedNew=$true
  $stage='launch'
  $started=LaunchApp ('--pet-update-token='+$plan.id)
  $stage='health'
  $deadline=[DateTime]::UtcNow.AddSeconds($HealthSeconds)
  $healthy=$false
  while ([DateTime]::UtcNow -lt $deadline) {
    $healthPath=Join-Path $job 'healthy.json'
    if (Test-Path -LiteralPath $healthPath) {
      try { $health=[System.IO.File]::ReadAllText($healthPath) | ConvertFrom-Json; if ($health.id -eq $plan.id -and $health.version -eq $plan.version) { $healthy=$true; break } } catch {}
    }
    Start-Sleep -Milliseconds 200
  }
  if (!$healthy) { throw 'New application did not pass its startup health check' }
  Receipt 'installed' 'Update installed successfully'
  exit 0
} catch {
  $failure=$stage+': '+$_.Exception.Message
  try {
    if ($movedNew) {
      if ($started -and !$started.HasExited) { & taskkill.exe /PID $started.Id /T /F 2>$null | Out-Null }
      Retry { [System.IO.Directory]::Move($target,$failed) }
    }
    if ($movedOld) { Retry { [System.IO.Directory]::Move($backup,$target) } }
    Receipt 'rolled-back' $failure
    if ($movedOld) { LaunchApp '' | Out-Null }
    exit 1
  } catch { Receipt 'recovery-needed' ($failure+'; rollback: '+$_.Exception.Message); exit 2 }
}
`;
