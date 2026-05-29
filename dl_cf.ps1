$p = "C:\Users\32849\.openclaw\workspace\podcast\cf.exe"
$u = "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe"
$c = New-Object System.Net.WebClient
Write-Output "Downloading..."
$c.DownloadFile($u, $p)
Write-Output "OK"
