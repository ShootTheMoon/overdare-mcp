# plan_render.ps1 — draw the plan_view.mjs rectangles into a PNG.
#
#   powershell -File plan_render.ps1 -In plan.json -Out plan.png
#
# Authored footprints are drawn first in grey, the generated placement over them in
# orange, so anything sitting in the wrong spot or turned the wrong way shows up as
# an orange box that does not cover its grey one.

param([string]$In, [string]$Out, [int]$Size = 1400)

Add-Type -AssemblyName System.Drawing
$data = Get-Content -Raw -Path $In | ConvertFrom-Json

$all = @($data.authored) + @($data.placed)
$minX = ($all | ForEach-Object { $_.x - $_.w } | Measure-Object -Minimum).Minimum
$maxX = ($all | ForEach-Object { $_.x + $_.w } | Measure-Object -Maximum).Maximum
$minZ = ($all | ForEach-Object { $_.z - $_.d } | Measure-Object -Minimum).Minimum
$maxZ = ($all | ForEach-Object { $_.z + $_.d } | Measure-Object -Maximum).Maximum
$scale = [Math]::Min($Size / ($maxX - $minX), $Size / ($maxZ - $minZ))

$bmp = New-Object System.Drawing.Bitmap $Size, $Size
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = "AntiAlias"
$g.Clear([System.Drawing.Color]::FromArgb(24, 26, 30))

function Draw($rects, $color, $fill) {
  $pen = New-Object System.Drawing.Pen $color, 1.5
  $brush = New-Object System.Drawing.SolidBrush $fill
  foreach ($r in $rects) {
    $cx = ($r.x - $minX) * $scale
    $cy = ($r.z - $minZ) * $scale
    $w = [Math]::Max(2, $r.w * $scale)
    $h = [Math]::Max(2, $r.d * $scale)
    $st = $g.Save()
    $g.TranslateTransform([float]$cx, [float]$cy)
    if ($r.yaw) { $g.RotateTransform([float]$r.yaw) }
    $rect = New-Object System.Drawing.RectangleF (-$w / 2), (-$h / 2), $w, $h
    $g.FillRectangle($brush, $rect)
    $g.DrawRectangle($pen, $rect.X, $rect.Y, $rect.Width, $rect.Height)
    $g.Restore($st)
  }
  $pen.Dispose(); $brush.Dispose()
}

Draw $data.authored ([System.Drawing.Color]::FromArgb(150, 130, 135, 145)) ([System.Drawing.Color]::FromArgb(70, 130, 135, 145))
Draw $data.placed   ([System.Drawing.Color]::FromArgb(230, 255, 150, 60))  ([System.Drawing.Color]::FromArgb(60, 255, 150, 60))

$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
Write-Output "rendered=$Out"
