# click.ps1 — click a point in the OVERDARE Studio window and screenshot the result.
#
#   powershell -File click.ps1 -X 586 -Y 41 -Out shot.png
#
# Coordinates are window-relative (the window's own client space), because the
# window is not always at the same screen position. Studio ignores programmatic
# activation from a background process, so the click is delivered as real input
# after attaching to its input queue.

param(
  [int]$X = -1, [int]$Y = -1,
  [string]$Out = "",
  [double]$SettleSec = 1.0,
  [int]$Clicks = 1          # 2 = double-click (list rows usually need it to open)
)

Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class C {
  [DllImport("shcore.dll")] public static extern int SetProcessDpiAwareness(int v);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool f);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint x, uint y, uint d, IntPtr e);
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
}
"@

[void][C]::SetProcessDpiAwareness(2)
Add-Type -AssemblyName System.Drawing

# Match on the process, not the title: a browser tab named "OVERDARE Creator Hub"
# makes Chrome look like Studio, and the click then lands in the wrong app.
$ids = @{}
Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -like 'Sandbox*' } |
  ForEach-Object { $ids[[uint32]$_.Id] = $true }
if ($ids.Count -eq 0) { Write-Output "STATUS=NO_STUDIO"; exit 1 }

# Restore every candidate before measuring — a minimized window reports its rect
# out at -32000 and would lose the "biggest window is the main one" comparison.
$script:cands = New-Object System.Collections.ArrayList
$cb = [C+EnumProc]{
  param($h, $p)
  $q = 0; [void][C]::GetWindowThreadProcessId($h, [ref]$q)
  if ($ids.ContainsKey([uint32]$q) -and [C]::IsWindowVisible($h)) { [void]$script:cands.Add($h) }
  return $true
}
[void][C]::EnumWindows($cb, [IntPtr]::Zero)

$hwnd = [IntPtr]::Zero; $area = 0
foreach ($h in $script:cands) {
  [void][C]::ShowWindow($h, 9)                 # SW_RESTORE
  $r = New-Object C+RECT; [void][C]::GetWindowRect($h, [ref]$r)
  $a = ($r.R - $r.L) * ($r.B - $r.T)
  if ($a -gt $area) { $area = $a; $hwnd = $h }
}
if ($hwnd -eq [IntPtr]::Zero) { Write-Output "STATUS=NO_WINDOW"; exit 1 }

# A minimized window reports its rect at -32000, so restore before measuring.
[void][C]::ShowWindow($hwnd, 9)      # SW_RESTORE
[void][C]::ShowWindow($hwnd, 3)      # SW_MAXIMIZE
Start-Sleep -Milliseconds 500

$r = New-Object C+RECT
[void][C]::GetWindowRect($hwnd, [ref]$r)
Write-Output ("window={0},{1} {2}x{3}" -f $r.L, $r.T, ($r.R - $r.L), ($r.B - $r.T))

$fg = [C]::GetForegroundWindow()
$me = [C]::GetCurrentThreadId()
$other = [C]::GetWindowThreadProcessId($fg, [ref]([uint32]0))
[void][C]::AttachThreadInput($me, $other, $true)
[void][C]::SetForegroundWindow($hwnd)
[void][C]::AttachThreadInput($me, $other, $false)
Start-Sleep -Milliseconds 400

if ($X -ge 0 -and $Y -ge 0) {
  [void][C]::SetCursorPos($r.L + $X, $r.T + $Y)
  Start-Sleep -Milliseconds 120
  for ($i = 0; $i -lt $Clicks; $i++) {
    [C]::mouse_event(0x0002, 0, 0, 0, [IntPtr]::Zero)
    [C]::mouse_event(0x0004, 0, 0, 0, [IntPtr]::Zero)
    if ($i -lt $Clicks - 1) { Start-Sleep -Milliseconds 60 }   # inside the double-click time
  }
  Write-Output ("clicked={0},{1} x{2}" -f ($r.L + $X), ($r.T + $Y), $Clicks)
}

Start-Sleep -Milliseconds ([int]($SettleSec * 1000))

if ($Out) {
  $w = $r.R - $r.L; $h = $r.B - $r.T
  $bmp = New-Object System.Drawing.Bitmap $w, $h
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($r.L, $r.T, 0, 0, (New-Object System.Drawing.Size $w, $h))
  $bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
  Write-Output "shot=$Out"
}
Write-Output "STATUS=OK"
