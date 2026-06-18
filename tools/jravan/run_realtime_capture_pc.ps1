param(
    [string]$Repo = "C:\keibamon",
    [string]$Races = "",
    [string]$Lake = ""
)

$ErrorActionPreference = "Stop"

function Write-Log {
    param([string]$Message)
    $line = "[{0}] {1}" -f (Get-Date -Format "yyyy-MM-ddTHH:mm:ssK"), $Message
    $line | Tee-Object -FilePath $script:LogPath -Append
}

Set-Location -LiteralPath $Repo

if (-not $Races) {
    $today = Get-Date -Format "yyyy-MM-dd"
    $Races = Join-Path $Repo "tools\jravan\manifests\$today.json"
}

if (-not $Lake) {
    $Lake = if ($env:KEIBAMON_LAKE) { $env:KEIBAMON_LAKE } else { "D:\keibamon\data" }
}

$logDir = Join-Path $Repo "logs\realtime"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$stamp = Get-Date -Format "yyyyMMddTHHmmss"
$script:LogPath = Join-Path $logDir "realtime-$stamp.log"

Write-Log "startup repo=$Repo races=$Races lake=$Lake"

$missing = @()
foreach ($name in @("CF_API_TOKEN", "CF_ACCOUNT_ID", "CF_D1_DATABASE_ID")) {
    if (-not [Environment]::GetEnvironmentVariable($name, "Process")) {
        $missing += $name
    }
}
if ($missing.Count -gt 0) {
    Write-Log ("FATAL missing Cloudflare env vars: " + ($missing -join ", "))
    exit 10
}

$python = Join-Path $Repo "venv32\Scripts\python.exe"
$worker = Join-Path $Repo "tools\jravan\realtime_jvlink.py"
if (-not (Test-Path -LiteralPath $python)) {
    Write-Log "FATAL missing 32-bit Python: $python"
    exit 11
}
if (-not (Test-Path -LiteralPath $worker)) {
    Write-Log "FATAL missing realtime worker: $worker"
    exit 12
}
if (-not (Test-Path -LiteralPath $Races)) {
    Write-Log "FATAL missing race manifest: $Races"
    exit 13
}

try {
    $manifest = Get-Content -LiteralPath $Races -Raw | ConvertFrom-Json
    if ($null -eq $manifest -or $manifest.Count -lt 1) {
        throw "manifest is empty"
    }
    $required = @("race_no", "year", "mmdd", "jyo", "kaiji", "nichiji", "post")
    foreach ($field in $required) {
        if ($null -eq $manifest[0].$field) {
            throw "manifest entries must include $($required -join ', '); missing $field"
        }
    }
} catch {
    Write-Log "FATAL invalid race manifest schema: $($_.Exception.Message)"
    exit 14
}

$env:KEIBAMON_LAKE = $Lake
$env:PYTHONPATH = Join-Path $Repo "src"
$env:PYTHONIOENCODING = "utf-8:backslashreplace"

Write-Log "preflight ok; launching JV-Link realtime worker"
& $python $worker --races $Races 2>&1 | ForEach-Object {
    Write-Log ($_ | Out-String).TrimEnd()
}
$rc = $LASTEXITCODE
Write-Log "worker exited rc=$rc"
exit $rc
