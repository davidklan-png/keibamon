param(
    [string]$TaskName = "KeibamonRealtimeCapture",
    [string]$Repo = "C:\keibamon",
    [string]$StartTime = "08:00"
)

$ErrorActionPreference = "Stop"

$wrapper = Join-Path $Repo "tools\jravan\run_realtime_capture_pc.ps1"
if (-not (Test-Path -LiteralPath $wrapper)) {
    throw "Missing wrapper: $wrapper"
}

$action = New-ScheduledTaskAction `
    -Execute "powershell.exe" `
    -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$wrapper`" -Repo `"$Repo`""
$trigger = New-ScheduledTaskTrigger -Daily -At $StartTime
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Description "Keibamon JV-Link realtime capture with CF preflight and timestamped logs" `
    -Force | Out-Null

Write-Host "Installed scheduled task: $TaskName"
Write-Host "Review with: Get-ScheduledTask -TaskName $TaskName"
