Add-Type -AssemblyName System.Drawing

function New-Icon {
    param(
        [int]$Size,
        [string]$Path
    )
    $bmp = New-Object System.Drawing.Bitmap $Size, $Size
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAlias

    # Background: rounded square, blue gradient-ish flat color
    $bgColor = [System.Drawing.Color]::FromArgb(255, 37, 99, 235)   # blue-600
    $brush = New-Object System.Drawing.SolidBrush $bgColor
    $g.FillRectangle($brush, 0, 0, $Size, $Size)

    # Clipboard body (white rounded rect)
    $pad = [int]($Size * 0.20)
    $cbW = $Size - 2 * $pad
    $cbH = [int]($Size * 0.66)
    $cbX = $pad
    $cbY = [int]($Size * 0.17)
    $white = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)
    $g.FillRectangle($white, $cbX, $cbY, $cbW, $cbH)

    # Clipboard clip (top)
    $clipW = [int]($Size * 0.28)
    $clipH = [int]($Size * 0.10)
    $clipX = $Size/2 - $clipW/2
    $clipY = $cbY - $clipH/2
    $clipBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 30, 64, 175))
    $g.FillRectangle($clipBrush, $clipX, $clipY, $clipW, $clipH)

    # Lines representing text on clipboard
    $lineBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 148, 163, 184))
    $lineH = [int]($Size * 0.045)
    $lineGap = [int]($Size * 0.10)
    $lineX = $cbX + [int]($Size*0.08)
    $lineWfull = $cbW - [int]($Size*0.16)
    for ($i = 0; $i -lt 3; $i++) {
        $ly = $cbY + [int]($Size*0.14) + $i * $lineGap
        $lw = if ($i -eq 2) { [int]($lineWfull * 0.6) } else { $lineWfull }
        $g.FillRectangle($lineBrush, $lineX, $ly, $lw, $lineH)
    }

    # Checkmark circle (bottom right of clipboard) - green
    $circR = [int]($Size * 0.20)
    $circX = $cbX + $cbW - $circR * 0.9
    $circY = $cbY + $cbH - $circR * 0.9
    $greenBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 22, 163, 74))
    $g.FillEllipse($greenBrush, $circX, $circY, $circR, $circR)

    $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::White), ([Math]::Max(2, $Size*0.02))
    $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $p1 = New-Object System.Drawing.PointF ($circX + $circR*0.25), ($circY + $circR*0.55)
    $p2 = New-Object System.Drawing.PointF ($circX + $circR*0.45), ($circY + $circR*0.75)
    $p3 = New-Object System.Drawing.PointF ($circX + $circR*0.78), ($circY + $circR*0.28)
    $g.DrawLines($pen, @($p1, $p2, $p3))

    $bmp.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose()
    $bmp.Dispose()
}

$dir = "C:\Users\hirsc\Downloads\Claude Arbeit\maengelliste-app\public\icons"
New-Icon -Size 192 -Path (Join-Path $dir "icon-192.png")
New-Icon -Size 512 -Path (Join-Path $dir "icon-512.png")
Write-Output "Icons erstellt"
