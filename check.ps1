$c = New-Object System.Net.WebClient
try {
    $d = $c.DownloadString("https://api.github.com/repos/superfly/flyctl/releases/latest")
    Write-Output $d
} catch {
    Write-Output "FAILED: " + $_.Exception.Message
}
