param(
    [int]$Port = 8080
)

Add-Type -AssemblyName System.Net

$root = Join-Path $PSScriptRoot "docs"
$root = [System.IO.Path]::GetFullPath($root)

$mime = @{
    ".html" = "text/html; charset=utf-8"
    ".js"   = "application/javascript; charset=utf-8"
    ".css"  = "text/css; charset=utf-8"
    ".json" = "application/json; charset=utf-8"
    ".png"  = "image/png"
    ".svg"  = "image/svg+xml"
    ".webmanifest" = "application/manifest+json"
}

$listener = New-Object System.Net.Sockets.TcpListener ([System.Net.IPAddress]::Any, $Port)
try {
    $listener.Start()
} catch {
    Write-Output "FEHLER: Konnte Port $Port nicht oeffnen. $_"
    exit 1
}

Write-Output "Server laeuft auf Port $Port - Root: $root"
Write-Output "READY"

function Send-Response {
    param($stream, [int]$statusCode, [string]$statusText, [string]$contentType, [byte[]]$body)
    $headerText = "HTTP/1.1 $statusCode $statusText`r`n" +
                  "Content-Type: $contentType`r`n" +
                  "Content-Length: $($body.Length)`r`n" +
                  "Cache-Control: no-cache`r`n" +
                  "Connection: close`r`n`r`n"
    $headerBytes = [System.Text.Encoding]::ASCII.GetBytes($headerText)
    $stream.Write($headerBytes, 0, $headerBytes.Length)
    if ($body.Length -gt 0) { $stream.Write($body, 0, $body.Length) }
    $stream.Flush()
}

while ($true) {
    $client = $listener.AcceptTcpClient()
    try {
        $client.ReceiveTimeout = 5000
        $stream = $client.GetStream()
        $buffer = New-Object byte[] 8192
        $read = $stream.Read($buffer, 0, $buffer.Length)
        if ($read -le 0) { $client.Close(); continue }
        $requestText = [System.Text.Encoding]::ASCII.GetString($buffer, 0, $read)
        $firstLine = ($requestText -split "`r`n")[0]
        $parts = $firstLine -split " "
        $path = "/index.html"
        if ($parts.Length -ge 2) {
            $path = $parts[1]
            if ($path -eq "/") { $path = "/index.html" }
            $path = $path.Split("?")[0]
        }

        $decodedPath = [System.Uri]::UnescapeDataString($path).TrimStart("/")
        $filePath = [System.IO.Path]::GetFullPath((Join-Path $root $decodedPath))

        if (-not $filePath.StartsWith($root)) {
            $body = [System.Text.Encoding]::UTF8.GetBytes("403 Forbidden")
            Send-Response $stream 403 "Forbidden" "text/plain" $body
        } elseif (Test-Path $filePath -PathType Leaf) {
            $ext = [System.IO.Path]::GetExtension($filePath).ToLower()
            $contentType = $mime[$ext]
            if (-not $contentType) { $contentType = "application/octet-stream" }
            $bytes = [System.IO.File]::ReadAllBytes($filePath)
            Send-Response $stream 200 "OK" $contentType $bytes
        } else {
            $body = [System.Text.Encoding]::UTF8.GetBytes("404 Not Found")
            Send-Response $stream 404 "Not Found" "text/plain" $body
        }
    } catch {
    } finally {
        try {
            $stream.Flush()
            $client.Client.Shutdown([System.Net.Sockets.SocketShutdown]::Send)
        } catch {}
        Start-Sleep -Milliseconds 20
        $client.Close()
    }
}
