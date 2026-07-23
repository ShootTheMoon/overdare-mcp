param([string]$Out = "$PSScriptRoot\studio.png")
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class Win {
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
"@
Add-Type -AssemblyName System.Drawing

# PrintWindow writes physical pixels. Without DPI awareness GetWindowRect reports
# logical ones, so the bitmap is too small and the capture comes out cropped.
try { Add-Type -MemberDefinition '[DllImport("shcore.dll")] public static extern int SetProcessDpiAwareness(int v);' -Name Dpi -Namespace W | Out-Null; [W.Dpi]::SetProcessDpiAwareness(2) | Out-Null } catch {}

# All Sandbox* process ids (editor + engine)
$pids = @{}
Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -like 'Sandbox*' } | ForEach-Object { $pids[[uint32]$_.Id] = $true }
if ($pids.Count -eq 0) { Write-Output "NO_PROCESS"; exit 1 }

$best = [IntPtr]::Zero; $bestArea = 0
$cb = [Win+EnumProc]{
  param($h, $p)
  $procId = 0
  [Win]::GetWindowThreadProcessId($h, [ref]$procId) | Out-Null
  if ($pids.ContainsKey([uint32]$procId)) {
    if ([Win]::IsIconic($h)) { [Win]::ShowWindow($h, 4) | Out-Null }  # SW_SHOWNOACTIVATE (no focus steal)
    if ([Win]::IsWindowVisible($h)) {
      $r = New-Object Win+RECT
      [Win]::GetWindowRect($h, [ref]$r) | Out-Null
      $area = ($r.Right - $r.Left) * ($r.Bottom - $r.Top)
      if ($area -gt $script:bestArea) { $script:bestArea = $area; $script:best = $h }
    }
  }
  return $true
}
[Win]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
if ($best -eq [IntPtr]::Zero) { Write-Output "NO_WINDOW"; exit 1 }

Start-Sleep -Milliseconds 250
$r = New-Object Win+RECT
[Win]::GetWindowRect($best, [ref]$r) | Out-Null
$w = $r.Right - $r.Left; $hh = $r.Bottom - $r.Top
$bmp = New-Object System.Drawing.Bitmap $w, $hh
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
$okr = [Win]::PrintWindow($best, $hdc, 2)
$g.ReleaseHdc($hdc); $g.Dispose()
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
Write-Output ("PRINTWINDOW={0} {1}x{2} -> {3}" -f $okr, $w, $hh, $Out)