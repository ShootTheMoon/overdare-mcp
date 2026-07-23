# viewport_focus.ps1 — force OVERDARE Studio to the front, select a node in the
# Level Browser, and frame it in the viewport (the "F" shortcut), then screenshot.
#
#   powershell -File viewport_focus.ps1 -Search "BerlinMap" -Out shot.png
#
# Editing Workspace.Camera does not reliably move the editor viewport, so driving
# the editor's own focus command is the only dependable way to look at something.

param(
  [string]$Search = "",
  [string]$Out = "",
  [int]$ItemX = 0, [int]$ItemY = 0
)

Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class V {
  [DllImport("shcore.dll")] public static extern int SetProcessDpiAwareness(int v);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint from, uint to, bool attach);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, int x, int y, uint d, IntPtr e);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte sc, uint f, IntPtr e);
  [DllImport("user32.dll")] public static extern bool SystemParametersInfo(uint a, uint b, IntPtr c, uint d);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  public struct POINT { public int X; public int Y; }
}
"@
[V]::SetProcessDpiAwareness(2) | Out-Null

$ids = @{}
Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -like 'Sandbox*' } |
  ForEach-Object { $ids[[uint32]$_.Id] = $true }
if ($ids.Count -eq 0) { Write-Output "STATUS=NO_STUDIO"; exit 1 }

$script:win = [IntPtr]::Zero; $script:area = 0
$cb = [V+EnumProc] {
  param($h, $p)
  $q = 0; [V]::GetWindowThreadProcessId($h, [ref]$q) | Out-Null
  if ($ids.ContainsKey([uint32]$q) -and [V]::IsWindowVisible($h)) {
    $r = New-Object V+RECT; [V]::GetWindowRect($h, [ref]$r) | Out-Null
    $a = ($r.Right - $r.Left) * ($r.Bottom - $r.Top)
    if ($a -gt $script:area) { $script:area = $a; $script:win = $h }
  }
  return $true
}
[V]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
if ($script:win -eq [IntPtr]::Zero) { Write-Output "STATUS=NO_WINDOW"; exit 1 }

# --- force foreground -----------------------------------------------------------
# Windows only lets the foreground process hand focus away. Attaching our input
# queue to that process's thread borrows the right long enough to take it.
[V]::SystemParametersInfo(0x2001, 0, [IntPtr]::Zero, 0) | Out-Null
if ([V]::IsIconic($script:win)) { [V]::ShowWindow($script:win, 9) | Out-Null }
[V]::ShowWindow($script:win, 3) | Out-Null    # SW_MAXIMIZE
$me = [V]::GetCurrentThreadId()
$fgw = [V]::GetForegroundWindow()
$q = 0; $fgt = [V]::GetWindowThreadProcessId($fgw, [ref]$q)
[V]::AttachThreadInput($me, $fgt, $true) | Out-Null
[V]::BringWindowToTop($script:win) | Out-Null
[V]::SetForegroundWindow($script:win) | Out-Null
[V]::AttachThreadInput($me, $fgt, $false) | Out-Null
Start-Sleep -Milliseconds 900

$q2 = 0; [V]::GetWindowThreadProcessId([V]::GetForegroundWindow(), [ref]$q2) | Out-Null
if (-not $ids.ContainsKey([uint32]$q2)) { Write-Output "STATUS=CANNOT_FOREGROUND"; exit 2 }
Write-Output "foreground=studio"

$rect = New-Object V+RECT; [V]::GetWindowRect($script:win, [ref]$rect) | Out-Null
$W = $rect.Right - $rect.Left; $H = $rect.Bottom - $rect.Top
Write-Output ("window={0},{1} {2}x{3}" -f $rect.Left, $rect.Top, $W, $H)

function Click([int]$x, [int]$y) {
  $p = New-Object V+POINT; $p.X = $x; $p.Y = $y
  $o = 0; [V]::GetWindowThreadProcessId([V]::WindowFromPoint($p), [ref]$o) | Out-Null
  if (-not $ids.ContainsKey([uint32]$o)) { Write-Output "STATUS=POINT_NOT_STUDIO"; exit 3 }
  [V]::SetCursorPos($x, $y) | Out-Null; Start-Sleep -Milliseconds 120
  [V]::mouse_event(0x0002, 0, 0, 0, [IntPtr]::Zero); Start-Sleep -Milliseconds 60
  [V]::mouse_event(0x0004, 0, 0, 0, [IntPtr]::Zero)
}

# --- pick the node in the Level Browser -----------------------------------------
# Searching beats hunting for a row: nested children are not visible until their
# parent is expanded, and the tree scrolls.
if ($Search -ne "") {
  Add-Type -AssemblyName System.Windows.Forms
  Click ($rect.Left + 2301) ($rect.Top + 313)          # search box
  Start-Sleep -Milliseconds 400
  # Typing goes through whatever IME is active — a Korean layout turns "Trabant"
  # into Hangul. Pasting bypasses the IME entirely.
  Set-Clipboard -Value $Search
  Start-Sleep -Milliseconds 200
  [System.Windows.Forms.SendKeys]::SendWait("^a")
  Start-Sleep -Milliseconds 120
  [System.Windows.Forms.SendKeys]::SendWait("^v")
  Start-Sleep -Milliseconds 1500
  # Double-clicking the row is the editor's own "focus on this" gesture; the F
  # shortcut needs viewport keyboard focus, which we cannot take without clicking
  # in the viewport and losing the selection.
  Click ($rect.Left + 2200) ($rect.Top + 385)          # first result row
  Start-Sleep -Milliseconds 300
  Click ($rect.Left + 2200) ($rect.Top + 385)
  Start-Sleep -Milliseconds 200
  Click ($rect.Left + 2200) ($rect.Top + 385)
  Start-Sleep -Milliseconds 1200
} elseif ($ItemX -gt 0) {
  Click ($rect.Left + $ItemX) ($rect.Top + $ItemY)
  Start-Sleep -Milliseconds 800
}

# --- frame it: "F" only applies while the pointer is over the 3D viewport -------
$vx = $rect.Left + [int]($W * 0.39)
$vy = $rect.Top + [int]($H * 0.55)
$p = New-Object V+POINT; $p.X = $vx; $p.Y = $vy
$o = 0; [V]::GetWindowThreadProcessId([V]::WindowFromPoint($p), [ref]$o) | Out-Null
if (-not $ids.ContainsKey([uint32]$o)) { Write-Output "STATUS=VIEWPORT_NOT_STUDIO"; exit 4 }
[V]::SetCursorPos($vx, $vy) | Out-Null
Start-Sleep -Milliseconds 300
[V]::keybd_event(0x46, 0, 0, [IntPtr]::Zero); Start-Sleep -Milliseconds 80
[V]::keybd_event(0x46, 0, 2, [IntPtr]::Zero)
Write-Output ("framed_at={0},{1}" -f $vx, $vy)
Start-Sleep -Seconds 3

if ($Out -ne "") { & "$PSScriptRoot\shot.ps1" -Out $Out | Out-Null; Write-Output "shot=$Out" }
Write-Output "STATUS=OK"
