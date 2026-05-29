$zip = "C:\Users\32849\.openclaw\workspace\podcast\flyctl.zip"
$url = "https://github.com/superfly/flyctl/releases/download/v0.3.55/flyctl_Windows_x86_64.zip"
$c = New-Object System.Net.WebClient
Write-Output "Downloading..."
$c.DownloadFile($url, $zip)
Write-Output "OK"
