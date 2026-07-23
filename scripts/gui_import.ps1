# gui_import.ps1 — drives OVERDARE Studio's Import dialog so meshes can be imported
# unattended. Studio exposes no import RPC (confirmed against the 0.8.1 runtime) and
# ships without Unreal Python, so the GUI is the only import surface there is.
#
#   powershell -File gui_import.ps1 -Files "C:\a.fbx,C:\b.fbx" [-Bulk] [-Shot out.png]
#
# Prints one STATUS=<...> line; anything else is diagnostic.

param(
  [Parameter(Mandatory = $true)][string]$Files,
  [switch]$Bulk,
  [string]$Shot = "",
  [int]$ImportX = 905, [int]$ImportY = 128,      # Home ribbon, window-relative
  [int]$BulkX = 997, [int]$BulkY = 137,
  [int]$RefWidth = 1721,                          # window width the coords were read at
  [int]$PreviewDX = 257, [int]$PreviewDY = 405,   # Import button, from window centre
  [switch]$WithTextures,                          # clear "Import Only as Model"
  [switch]$NoConfirm,                             # stop at the options dialog and screenshot
  [int]$ModelOnlyDX = 96, [int]$ModelOnlyDY = -298,
  [int]$PreviewWaitSec = 5,
  [int]$SettleSec = 0,                            # let a previous import finish first
  [int]$DialogTimeoutSec = 25
)

Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class G {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, int x, int y, uint d, IntPtr e);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte sc, uint f, IntPtr e);
  [DllImport("user32.dll")] public static extern bool SystemParametersInfo(uint a, uint b, IntPtr c, uint d);
  [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("shcore.dll")] public static extern int SetProcessDpiAwareness(int v);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern IntPtr FindWindowEx(IntPtr parent, IntPtr child, string cls, string win);
  [DllImport("user32.dll", CharSet=CharSet.Auto, EntryPoint="SendMessage")] public static extern IntPtr SetText(IntPtr h, uint msg, IntPtr w, string l);
  [DllImport("user32.dll", EntryPoint="SendMessage")] public static extern IntPtr Msg(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern IntPtr GetDlgItem(IntPtr h, int id);
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  public struct POINT { public int X; public int Y; }
}
"@
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing      # Bulk Import finds its button by colour

# Physical-pixel coordinates: without this, clicks land scaled on a 125% display.
try { [G]::SetProcessDpiAwareness(2) | Out-Null } catch {}

function Get-ProcName([IntPtr]$h) {
  $procId = 0; [G]::GetWindowThreadProcessId($h, [ref]$procId) | Out-Null
  $p = Get-Process -Id $procId -ErrorAction SilentlyContinue
  if ($p) { return $p.ProcessName } else { return "" }
}

# A locked session swallows every synthetic click, so fail loudly instead of
# pretending the import happened.
$fg = Get-ProcName ([G]::GetForegroundWindow())
if ($fg -eq "LockApp" -or $fg -eq "LogonUI") { Write-Output "STATUS=LOCKED"; exit 2 }

# Studio ignores the ribbon while it is still building the previous mesh.
if ($SettleSec -gt 0) { Start-Sleep -Seconds $SettleSec }

# --- locate Studio's main window (largest visible Sandbox* window) --------------
$ids = @{}
Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -like 'Sandbox*' } |
  ForEach-Object { $ids[[uint32]$_.Id] = $true }
if ($ids.Count -eq 0) { Write-Output "STATUS=NO_STUDIO"; exit 1 }

$script:win = [IntPtr]::Zero; $script:area = 0
$cb = [G+EnumProc] {
  param($h, $p)
  $procId = 0; [G]::GetWindowThreadProcessId($h, [ref]$procId) | Out-Null
  if ($ids.ContainsKey([uint32]$procId)) {
    if ([G]::IsIconic($h)) { [G]::ShowWindow($h, 9) | Out-Null }   # SW_RESTORE
    if ([G]::IsWindowVisible($h)) {
      $r = New-Object G+RECT; [G]::GetWindowRect($h, [ref]$r) | Out-Null
      $a = ($r.Right - $r.Left) * ($r.Bottom - $r.Top)
      if ($a -gt $script:area) { $script:area = $a; $script:win = $h }
    }
  }
  return $true
}
[G]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
if ($script:win -eq [IntPtr]::Zero) { Write-Output "STATUS=NO_WINDOW"; exit 1 }

# Maximize so the ribbon lays out exactly as it did when the coordinates were read —
# a narrower window reflows the toolbar and moves the Import button.
[G]::ShowWindow($script:win, 3) | Out-Null   # SW_MAXIMIZE
Start-Sleep -Milliseconds 800

$rect = New-Object G+RECT; [G]::GetWindowRect($script:win, [ref]$rect) | Out-Null
Write-Output ("window={0},{1} {2}x{3}" -f $rect.Left, $rect.Top, ($rect.Right - $rect.Left), ($rect.Bottom - $rect.Top))

# --- focus Studio ---------------------------------------------------------------
# Windows only hands focus to the foreground app; dropping the lock timeout and
# tapping Alt makes SetForegroundWindow succeed from a background script.
[G]::SystemParametersInfo(0x2001, 0, [IntPtr]::Zero, 0) | Out-Null   # SPI_SETFOREGROUNDLOCKTIMEOUT
$shell = New-Object -ComObject WScript.Shell
$studioId = 0; [G]::GetWindowThreadProcessId($script:win, [ref]$studioId) | Out-Null
for ($i = 0; $i -lt 5; $i++) {
  if ([G]::GetForegroundWindow() -eq $script:win) { break }
  [G]::keybd_event(0x12, 0, 0, [IntPtr]::Zero); Start-Sleep -Milliseconds 40
  [G]::keybd_event(0x12, 0, 2, [IntPtr]::Zero)
  [G]::SetForegroundWindow($script:win) | Out-Null
  try { $shell.AppActivate([int]$studioId) | Out-Null } catch {}
  Start-Sleep -Milliseconds 500
}
# Pin Studio topmost for the duration of the import. The controlling process (the
# agent's own console) keeps grabbing the foreground back between our tool calls,
# which is what produced the endless NO_FILE_DIALOG / FOREGROUND_LOST retries — the
# ribbon click landed on whatever window had jumped in front. HWND_TOPMOST keeps
# Studio and its modal file dialog above those, so the clicks land where intended.
# It is cleared again at the end.
$HWND_TOPMOST = New-Object IntPtr(-1)
$HWND_NOTOPMOST = New-Object IntPtr(-2)
[G]::SetWindowPos($script:win, $HWND_TOPMOST, 0, 0, 0, 0, 0x0013) | Out-Null  # NOMOVE|NOSIZE|SHOWWINDOW
[G]::SetForegroundWindow($script:win) | Out-Null
Start-Sleep -Milliseconds 300

function Clear-Topmost {
  if ($script:win -ne [IntPtr]::Zero) {
    [G]::SetWindowPos($script:win, (New-Object IntPtr(-2)), 0, 0, 0, 0, 0x0013) | Out-Null
  }
}

$focused = [G]::GetForegroundWindow() -eq $script:win
Write-Output ("focus={0}" -f $focused)

# Synthetic clicks go wherever the pointer is, so a click aimed at Studio lands in
# whatever app the user just switched to. Never click unless Studio still owns the
# foreground — a misfired click into someone's browser is worse than a failed import.
# Studio's own file dialogs take the foreground, so the test is which *process*
# owns it, not whether it is the main window.
function Assert-Studio {
  $q = 0; [G]::GetWindowThreadProcessId([G]::GetForegroundWindow(), [ref]$q) | Out-Null
  if (-not $ids.ContainsKey([uint32]$q)) {
    Clear-Topmost
    Write-Output "STATUS=FOREGROUND_LOST"
    exit 5
  }
}

# Activating by click is only safe when the pixel really belongs to Studio; if another
# window covers that spot, the click goes to that window instead.
function Test-StudioAt([int]$x, [int]$y) {
  $p = New-Object G+POINT; $p.X = $x; $p.Y = $y
  $q = 0; [G]::GetWindowThreadProcessId([G]::WindowFromPoint($p), [ref]$q) | Out-Null
  return $ids.ContainsKey([uint32]$q)
}

function Find-Dialog {
  $script:found = [IntPtr]::Zero
  $cb2 = [G+EnumProc] {
    param($h, $p)
    $procId = 0; [G]::GetWindowThreadProcessId($h, [ref]$procId) | Out-Null
    if ($ids.ContainsKey([uint32]$procId) -and [G]::IsWindowVisible($h)) {
      $sb = New-Object System.Text.StringBuilder 256
      [G]::GetClassName($h, $sb, 256) | Out-Null
      if ($sb.ToString() -eq "#32770") { $script:found = $h; return $false }
    }
    return $true
  }
  [G]::EnumWindows($cb2, [IntPtr]::Zero) | Out-Null
  return $script:found
}

function Click([int]$x, [int]$y) {
  [G]::SetCursorPos($x, $y) | Out-Null
  Start-Sleep -Milliseconds 120
  [G]::mouse_event(0x0002, 0, 0, 0, [IntPtr]::Zero)   # LEFTDOWN
  Start-Sleep -Milliseconds 60
  [G]::mouse_event(0x0004, 0, 0, 0, [IntPtr]::Zero)   # LEFTUP
}

# --- open the import file dialog -------------------------------------------------
# The ribbon coordinates were read off a capture taken by a DPI-unaware process, so
# they are logical pixels; this script is DPI-aware and clicks in physical ones. The
# ribbon is anchored top-left and scales with DPI, not with the window's width, so
# the display scale — never the window size — is what converts between the two.
# PrintWindow writes physical pixels (it crops rather than scales), and this script
# is DPI-aware, so the captured offsets and GetWindowRect are already in the same
# space. No DPI conversion belongs here — adding one is what broke earlier runs.
$scale = 1.0

# SetForegroundWindow is unreliable from a background script, but a synthetic click
# counts as real input: clicking the already-selected Home tab activates the window
# and guarantees the Home ribbon (where Import lives) is the visible one.
# A dialog left open by an interrupted run is reusable; clicking Import again would
# just stack a second one behind it.
$dlg = Find-Dialog
if ($dlg -ne [IntPtr]::Zero) {
  Write-Output "file_dialog=reused"
} else {
  if (-not $focused) {
    $hx = $rect.Left + [int](283 * $scale); $hy = $rect.Top + [int](41 * $scale)
    if (-not (Test-StudioAt $hx $hy)) { Write-Output "STATUS=STUDIO_COVERED"; exit 6 }
    Click $hx $hy
    Start-Sleep -Milliseconds 700
  }
  if ($Bulk) { $bx = $rect.Left + [int]($BulkX * $scale); $by = $rect.Top + [int]($BulkY * $scale) }
  else       { $bx = $rect.Left + [int]($ImportX * $scale); $by = $rect.Top + [int]($ImportY * $scale) }
  Write-Output ("click_import={0},{1} bulk={2}" -f $bx, $by, [bool]$Bulk)
  Assert-Studio
  Click $bx $by

  $deadline = (Get-Date).AddSeconds($DialogTimeoutSec)
  while ((Get-Date) -lt $deadline -and $dlg -eq [IntPtr]::Zero) {
    Start-Sleep -Milliseconds 400
    $dlg = Find-Dialog
  }
  if ($dlg -eq [IntPtr]::Zero) { Write-Output "STATUS=NO_FILE_DIALOG"; exit 3 }
  Write-Output "file_dialog=found"
}
[G]::SetForegroundWindow($dlg) | Out-Null
Start-Sleep -Milliseconds 400

# --- hand it the paths -----------------------------------------------------------
# Quoted, space-separated paths are how a Win32 file dialog takes a multi-selection,
# and pasting sidesteps every keyboard-layout and special-character problem.
$list = ($Files -split ',' | ForEach-Object { '"' + $_.Trim() + '"' }) -join ' '

# Write straight into the dialog's edit control and press its OK button. Typing or
# pasting depends on which child control happens to hold focus — on a dialog reused
# from a previous run that is the file list, where the keystrokes do nothing useful.
$edit = [IntPtr]::Zero
$cbex = [G]::FindWindowEx($dlg, [IntPtr]::Zero, "ComboBoxEx32", $null)
if ($cbex -ne [IntPtr]::Zero) {
  $cb = [G]::FindWindowEx($cbex, [IntPtr]::Zero, "ComboBox", $null)
  if ($cb -ne [IntPtr]::Zero) { $edit = [G]::FindWindowEx($cb, [IntPtr]::Zero, "Edit", $null) }
  if ($edit -eq [IntPtr]::Zero) { $edit = [G]::FindWindowEx($cbex, [IntPtr]::Zero, "Edit", $null) }
}
if ($edit -eq [IntPtr]::Zero) { $edit = [G]::GetDlgItem($dlg, 1148) }

if ($edit -ne [IntPtr]::Zero) {
  [G]::SetText($edit, 0x000C, [IntPtr]::Zero, $list) | Out-Null   # WM_SETTEXT
  Write-Output "filename_set=control"
} else {
  Set-Clipboard -Value $list
  Start-Sleep -Milliseconds 250
  [System.Windows.Forms.SendKeys]::SendWait("^a"); Start-Sleep -Milliseconds 150
  [System.Windows.Forms.SendKeys]::SendWait("^v")
  Write-Output "filename_set=paste_fallback"
}
Start-Sleep -Milliseconds 400

$ok = [G]::GetDlgItem($dlg, 1)      # IDOK — the Open button
if ($ok -ne [IntPtr]::Zero) { [G]::Msg($ok, 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null }  # BM_CLICK
else { [System.Windows.Forms.SendKeys]::SendWait("{ENTER}") }
Write-Output ("pasted_files={0}" -f ($Files -split ',').Count)

# A path the dialog rejects leaves it sitting open with the text still in the box.
# Without this check the script would sail on and report an import that never
# happened, which is worse than failing.
Start-Sleep -Milliseconds 1500
if ((Find-Dialog) -ne [IntPtr]::Zero) {
  [System.Windows.Forms.SendKeys]::SendWait("{ESC}")
  Clear-Topmost
  Write-Output "STATUS=PATH_REJECTED"
  exit 7
}

# --- confirm the Import Preview ---------------------------------------------------
# Slate draws the preview inside the main window, so there is no HWND to wait on.
# Its defaults are already what we want (import as Model, insert in Workspace, CM),
# and it is centred, so the confirm button sits at a fixed offset from the centre.
Start-Sleep -Seconds $PreviewWaitSec
$cx = $rect.Left + ([int](($rect.Right - $rect.Left) / 2))
$cy = $rect.Top + ([int](($rect.Bottom - $rect.Top) / 2))

if ($NoConfirm) {
  if ($Out -ne "") { & "$PSScriptRoot\shot.ps1" -Out $Out | Out-Null; Write-Output "shot=$Out" }
  Clear-Topmost
  Write-Output "STATUS=AWAITING_CONFIRM"
  exit 0
}

# Bulk Import puts up a DIFFERENT dialog — "Mesh Import Options", confirmed with
# Cancel / Apply / Apply All instead of the single import's Import button. Clicking
# the single-import offset leaves that modal open, and while it is up Studio accepts
# TCP on 13377/30010 but answers nothing, so even level.save.file times out and the
# import silently registers nothing.
#
# Its accent button is a saturated blue that nothing else on screen matches, so find
# it by colour rather than by a remembered offset — the offsets are what kept
# breaking whenever the window changed size.
if ($Bulk) {
  Assert-Studio
  $w = $rect.Right - $rect.Left; $h = $rect.Bottom - $rect.Top
  $bmp = New-Object System.Drawing.Bitmap $w, $h
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($rect.Left, $rect.Top, 0, 0, (New-Object System.Drawing.Size $w, $h))
  $data = $bmp.LockBits((New-Object System.Drawing.Rectangle 0, 0, $w, $h),
            [System.Drawing.Imaging.ImageLockMode]::ReadOnly,
            [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $bytes = New-Object byte[] ($data.Stride * $h)
  [System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $bytes, 0, $bytes.Length)
  $bmp.UnlockBits($data)

  # Accent blue, sampled coarsely; only the lower half of the window can hold the
  # dialog's button row, which keeps ribbon highlights out of the result.
  $best = $null; $bestX = -1
  $cell = @{}
  for ($y = [int]($h * 0.35); $y -lt $h; $y += 3) {
    $row = $y * $data.Stride
    for ($x = 0; $x -lt $w; $x += 3) {
      $i = $row + $x * 4
      $b = $bytes[$i]; $gr = $bytes[$i + 1]; $r = $bytes[$i + 2]
      if ($b -gt 150 -and ($b - $r) -gt 60 -and ($b - $gr) -gt 40) {
        $key = "$([int]($x / 24))_$([int]($y / 24))"
        if (-not $cell.ContainsKey($key)) { $cell[$key] = @{ n = 0; sx = 0; sy = 0 } }
        $cell[$key].n++; $cell[$key].sx += $x; $cell[$key].sy += $y
      }
    }
  }
  $g.Dispose(); $bmp.Dispose()

  # Merge neighbouring cells into blobs, keep the rightmost sizeable one: the button
  # row reads Cancel, Apply, Apply All, and Apply All is the one that commits every
  # file in the bundle.
  foreach ($k in $cell.Keys) {
    $c = $cell[$k]
    if ($c.n -lt 12) { continue }
    $mx = [int]($c.sx / $c.n); $my = [int]($c.sy / $c.n)
    if ($mx -gt $bestX) { $bestX = $mx; $best = @{ x = $mx; y = $my; n = $c.n } }
  }

  if ($null -eq $best) {
    if ($Shot -ne "") { & "$PSScriptRoot\shot.ps1" -Out $Shot | Out-Null; Write-Output "shot=$Shot" }
    Clear-Topmost
    Write-Output "STATUS=NO_APPLY_BUTTON"
    exit 4
  }
  Click ($rect.Left + $best.x) ($rect.Top + $best.y)
  Write-Output ("clicked_apply_all={0},{1} (blue px {2})" -f ($rect.Left + $best.x), ($rect.Top + $best.y), $best.n)

  # After Apply All, Studio cooks and uploads each mesh, then puts up a "Bulk Import —
  # Completed" panel with only an X and an Import button. THAT panel blocks the next
  # import's ribbon click (the endless NO_FILE_DIALOG), so it has to be dismissed —
  # this is the "close" a human kept pressing. Escape closes the Slate panel without
  # needing its (DPI-dependent) button coordinates. Cooking takes a while and the
  # panel only appears at the end, so keep the window focused and tap Escape a few
  # times across the wait rather than once too early.
  for ($w = 0; $w -lt 6; $w++) {
    Start-Sleep -Seconds 5
    [G]::SetForegroundWindow($script:win) | Out-Null
    [G]::keybd_event(0x1B, 0, 0, [IntPtr]::Zero); Start-Sleep -Milliseconds 60   # ESC down
    [G]::keybd_event(0x1B, 0, 2, [IntPtr]::Zero)                                 # ESC up
  }
  if ($Shot -ne "") { & "$PSScriptRoot\shot.ps1" -Out $Shot | Out-Null; Write-Output ("shot={0}" -f $Shot) }
  Clear-Topmost
  Write-Output "STATUS=IMPORTED"
  exit 0
}
# "Import Only as Model" is on by default and brings the mesh in WITHOUT linking its
# texture, which is why imported assets keep arriving with an empty TextureId.
if ($WithTextures) {
  Assert-Studio
  Click ($cx + $ModelOnlyDX) ($cy + $ModelOnlyDY)
  Write-Output ("unchecked_model_only={0},{1}" -f ($cx + $ModelOnlyDX), ($cy + $ModelOnlyDY))
  Start-Sleep -Milliseconds 600
}

Assert-Studio
Click ($cx + $PreviewDX) ($cy + $PreviewDY)
Write-Output ("clicked_preview_import={0},{1}" -f ($cx + $PreviewDX), ($cy + $PreviewDY))

Start-Sleep -Seconds 4
if ($Shot -ne "") {
  & "$PSScriptRoot\shot.ps1" -Out $Shot | Out-Null
  Write-Output ("shot={0}" -f $Shot)
}
Clear-Topmost
Write-Output "STATUS=IMPORTED"
