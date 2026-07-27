param(
  [string]$OutputDirectory = (Join-Path $PSScriptRoot "..\public")
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

function New-RoundedRectanglePath {
  param([float]$X, [float]$Y, [float]$Width, [float]$Height, [float]$Radius)
  $path = [Drawing.Drawing2D.GraphicsPath]::new()
  $diameter = $Radius * 2
  $path.AddArc($X, $Y, $diameter, $diameter, 180, 90)
  $path.AddArc($X + $Width - $diameter, $Y, $diameter, $diameter, 270, 90)
  $path.AddArc($X + $Width - $diameter, $Y + $Height - $diameter, $diameter, $diameter, 0, 90)
  $path.AddArc($X, $Y + $Height - $diameter, $diameter, $diameter, 90, 90)
  $path.CloseFigure()
  return $path
}

function New-AppIcon {
  param([int]$Size, [string]$FileName)
  $bitmap = [Drawing.Bitmap]::new($Size, $Size, [Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $graphics = [Drawing.Graphics]::FromImage($bitmap)
  $graphics.SmoothingMode = [Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $graphics.PixelOffsetMode = [Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $graphics.Clear([Drawing.ColorTranslator]::FromHtml("#080708"))

  $margin = [float]($Size * 0.094)
  $side = [float]($Size - ($margin * 2))
  $radius = [float]($Size * 0.218)
  $facePath = New-RoundedRectanglePath -X $margin -Y $margin -Width $side -Height $side -Radius $radius
  $bounds = [Drawing.RectangleF]::new($margin, $margin, $side, $side)
  $fill = [Drawing.Drawing2D.LinearGradientBrush]::new($bounds, [Drawing.ColorTranslator]::FromHtml("#B52837"), [Drawing.ColorTranslator]::FromHtml("#3B080E"), 52)
  $graphics.FillPath($fill, $facePath)

  $border = [Drawing.Pen]::new([Drawing.Color]::FromArgb(48, 255, 255, 255), [float]([Math]::Max(1, $Size * 0.004)))
  $graphics.DrawPath($border, $facePath)

  $pen = [Drawing.Pen]::new([Drawing.ColorTranslator]::FromHtml("#FFF7F8"), [float]($Size * 0.055))
  $pen.StartCap = [Drawing.Drawing2D.LineCap]::Round
  $pen.EndCap = [Drawing.Drawing2D.LineCap]::Round
  $pen.LineJoin = [Drawing.Drawing2D.LineJoin]::Round

  $leftEye = [Drawing.PointF[]]@(
    [Drawing.PointF]::new($Size * 0.299, $Size * 0.371),
    [Drawing.PointF]::new($Size * 0.426, $Size * 0.465),
    [Drawing.PointF]::new($Size * 0.299, $Size * 0.559)
  )
  $rightEye = [Drawing.PointF[]]@(
    [Drawing.PointF]::new($Size * 0.701, $Size * 0.371),
    [Drawing.PointF]::new($Size * 0.574, $Size * 0.465),
    [Drawing.PointF]::new($Size * 0.701, $Size * 0.559)
  )
  $graphics.DrawLines($pen, $leftEye)
  $graphics.DrawLines($pen, $rightEye)
  $graphics.DrawLine($pen, $Size * 0.406, $Size * 0.645, $Size * 0.594, $Size * 0.645)

  $target = Join-Path $OutputDirectory $FileName
  $bitmap.Save($target, [Drawing.Imaging.ImageFormat]::Png)
  $pen.Dispose(); $border.Dispose(); $fill.Dispose(); $facePath.Dispose(); $graphics.Dispose(); $bitmap.Dispose()
}

New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
New-AppIcon -Size 180 -FileName "app-icon-180.png"
New-AppIcon -Size 192 -FileName "app-icon-192.png"
New-AppIcon -Size 512 -FileName "app-icon-512.png"
