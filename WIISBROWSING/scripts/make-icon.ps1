# Generates the original WIISBROWSING logo (PNG + multi-size ICO). No third-party artwork is used.
param([string]$Out = (Join-Path $PSScriptRoot "..\src\WIISBROWSING.App\Assets"))
Add-Type -AssemblyName System.Drawing
New-Item -ItemType Directory -Force $Out | Out-Null

function New-LogoBitmap([int]$size) {
    $bmp = New-Object System.Drawing.Bitmap $size, $size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = 'AntiAlias'; $g.PixelOffsetMode = 'HighQuality'; $g.InterpolationMode = 'HighQualityBicubic'
    $g.Clear([System.Drawing.Color]::Transparent)
    $s = $size / 256.0

    # squircle plate
    $r = 58 * $s; $m = 10 * $s; $w = $size - 2 * $m
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $path.AddArc($m, $m, 2*$r, 2*$r, 180, 90); $path.AddArc($m + $w - 2*$r, $m, 2*$r, 2*$r, 270, 90)
    $path.AddArc($m + $w - 2*$r, $m + $w - 2*$r, 2*$r, 2*$r, 0, 90); $path.AddArc($m, $m + $w - 2*$r, 2*$r, 2*$r, 90, 90)
    $path.CloseFigure()
    $plate = New-Object System.Drawing.Drawing2D.LinearGradientBrush ((New-Object System.Drawing.PointF 0,0), (New-Object System.Drawing.PointF $size,$size), ([System.Drawing.Color]::FromArgb(255,26,22,52)), ([System.Drawing.Color]::FromArgb(255,9,10,15)))
    $g.FillPath($plate, $path)

    # soft glow behind the mark
    $glow = New-Object System.Drawing.Drawing2D.GraphicsPath
    $glow.AddEllipse(60*$s, 70*$s, 140*$s, 140*$s)
    $pgb = New-Object System.Drawing.Drawing2D.PathGradientBrush $glow
    $pgb.CenterColor = [System.Drawing.Color]::FromArgb(110, 139, 92, 246)
    $pgb.SurroundColors = @([System.Drawing.Color]::FromArgb(0, 139, 92, 246))
    $g.FillPath($pgb, $glow)

    # the W ribbon
    $pts = @(
        (New-Object System.Drawing.PointF (58*$s), (84*$s)),
        (New-Object System.Drawing.PointF (92*$s), (176*$s)),
        (New-Object System.Drawing.PointF (128*$s), (110*$s)),
        (New-Object System.Drawing.PointF (164*$s), (176*$s)),
        (New-Object System.Drawing.PointF (198*$s), (84*$s))
    )
    $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::White), (22*$s)
    $pen.LineJoin = 'Round'; $pen.StartCap = 'Round'; $pen.EndCap = 'Round'
    $grad = New-Object System.Drawing.Drawing2D.LinearGradientBrush ((New-Object System.Drawing.PointF (50*$s),(80*$s))), ((New-Object System.Drawing.PointF (206*$s),(180*$s))), ([System.Drawing.Color]::FromArgb(255,196,181,253)), ([System.Drawing.Color]::FromArgb(255,99,102,241))
    $pen.Brush = $grad
    $g.DrawLines($pen, $pts)

    # orbit dot (the "browsing" spark)
    $dot = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 244, 114, 182))
    $g.FillEllipse($dot, 178*$s, 52*$s, 26*$s, 26*$s)
    $g.Dispose()
    return $bmp
}

$sizes = 16, 24, 32, 48, 64, 128, 256
$pngs = @{}
foreach ($sz in $sizes) {
    $b = New-LogoBitmap $sz
    $ms = New-Object System.IO.MemoryStream
    $b.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $pngs[$sz] = $ms.ToArray()
    $b.Dispose()
}
$big = New-LogoBitmap 512
$big.Save((Join-Path $Out "logo.png"), [System.Drawing.Imaging.ImageFormat]::Png)
$big.Dispose()

# assemble .ico (PNG-compressed entries)
$fs = [System.IO.File]::Create((Join-Path $Out "wiisbrowsing.ico"))
$bw = New-Object System.IO.BinaryWriter $fs
$bw.Write([uint16]0); $bw.Write([uint16]1); $bw.Write([uint16]$sizes.Count)
$offset = 6 + 16 * $sizes.Count
foreach ($sz in $sizes) {
    $bytes = $pngs[$sz]
    $bw.Write([byte]($(if ($sz -ge 256) { 0 } else { $sz }))); $bw.Write([byte]($(if ($sz -ge 256) { 0 } else { $sz })))
    $bw.Write([byte]0); $bw.Write([byte]0); $bw.Write([uint16]1); $bw.Write([uint16]32)
    $bw.Write([uint32]$bytes.Length); $bw.Write([uint32]$offset)
    $offset += $bytes.Length
}
foreach ($sz in $sizes) { $bw.Write($pngs[$sz]) }
$bw.Close(); $fs.Close()
"Wrote logo.png and wiisbrowsing.ico to $Out"
