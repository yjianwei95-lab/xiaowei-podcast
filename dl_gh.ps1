$c = New-Object System.Net.WebClient
$url = "https://github.com/cli/cli/releases/latest/download/gh_2.70.0_windows_amd64.msi"
$out = "C:\Users\32849\.openclaw\workspace\gh.msi"
Write-Output "Downloading gh CLI..."
$c.DownloadFile($url, $out)
Write-Output "OK"
