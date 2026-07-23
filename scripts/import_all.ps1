# import_all.ps1 — import a list of prepared FBX files one at a time.
#
#   powershell -File import_all.ps1 -Dir C:\Users\29\Desktop\MeshTest\Rebake
#   powershell -File import_all.ps1 -Files "a.fbx,b.fbx"
#
# The file dialog accepts several quoted paths but Studio only ever imports the
# first, so a batch has to be driven one file per trip through the ribbon. Studio
# also refuses to open the dialog while it is still ingesting the previous mesh,
# which shows up as NO_FILE_DIALOG — so each file gets retried with a longer wait
# rather than being silently dropped.

param(
  [string]$Dir = "",
  [string]$Files = "",
  [int]$Tries = 3,
  [int]$SettleSec = 12,
  [switch]$Bulk,                 # forward to gui_import for multi-mesh bundles
  [switch]$WithTextures = $true  # single-import path needs this to link textures
)

$S = Split-Path -Parent $MyInvocation.MyCommand.Path

$list = @()
if ($Files) { $list = $Files -split ',' | ForEach-Object { $_.Trim() } }
elseif ($Dir) { $list = Get-ChildItem -Path $Dir -Filter '*_overdare.fbx' | ForEach-Object { $_.FullName } }
if (-not $list) { Write-Output "STATUS=NOTHING_TO_IMPORT"; exit 1 }

# Studio blocks its UI thread while it ingests a mesh — for a 30k-triangle model
# with a 1K texture that runs into minutes. Driving the ribbon during that window
# is what produces NO_FILE_DIALOG, and hammering it with retries only adds input
# to a queue that is not being read. Wait for the editor to actually be alive:
# the window pumping messages AND the RPC port answering.
function Wait-StudioReady([int]$TimeoutSec = 600) {
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  while ((Get-Date) -lt $deadline) {
    $p = Get-Process -Name 'Sandbox*' -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $p) { return $false }
    if ($p.Responding) {
      $c = New-Object System.Net.Sockets.TcpClient
      try {
        if ($c.ConnectAsync('127.0.0.1', 13377).Wait(2000)) { $c.Close(); return $true }
      } catch { }
      finally { $c.Dispose() }
    }
    Start-Sleep -Seconds 5
  }
  return $false
}

Write-Output ("files={0}" -f $list.Count)
$okCount = 0
$failed = @()

foreach ($f in $list) {
  $name = [System.IO.Path]::GetFileNameWithoutExtension($f)
  $done = $false
  for ($i = 1; $i -le $Tries -and -not $done; $i++) {
    if (-not (Wait-StudioReady)) {
      Write-Output ("  {0} attempt {1}: STUDIO_NOT_READY" -f $name, $i)
      continue
    }
    $extra = @()
    if ($Bulk) { $extra += "-Bulk" } elseif ($WithTextures) { $extra += "-WithTextures" }
    $out = & powershell -ExecutionPolicy Bypass -File "$S\gui_import.ps1" `
             -Files $f -PreviewWaitSec 15 -SettleSec $SettleSec @extra 2>&1
    $status = ($out | Select-String 'STATUS=([A-Z_]+)').Matches.Value
    if ($status -eq 'STATUS=IMPORTED') { $done = $true; $okCount++ }
    else { Write-Output ("  {0} attempt {1}: {2}" -f $name, $i, $status) }
  }
  Write-Output ("{0} -> {1}" -f $name, $(if ($done) { 'IMPORTED' } else { 'FAILED' }))
  if (-not $done) { $failed += $name }
}

Write-Output ("imported={0}/{1}" -f $okCount, $list.Count)
if ($failed) { Write-Output ("failed=" + ($failed -join ',')) }
Write-Output "STATUS=OK"
