param(
  [string]$StateDirectory = (Join-Path $env:USERPROFILE '.cloudcli\provider-usage'),
  [string]$NodeExecutable = 'C:\Program Files\nodejs\node.exe',
  [string]$TaskName = 'Claudex-Usage-WorkBuddy-30min'
)
$ErrorActionPreference = 'Stop'
$worker = Join-Path $PSScriptRoot 'worker.cjs'
if (!(Test-Path -LiteralPath $worker) -or !(Test-Path -LiteralPath $NodeExecutable)) { throw 'Usage worker or Node executable missing.' }
New-Item -ItemType Directory -Force -Path $StateDirectory | Out-Null
$state = (Resolve-Path -LiteralPath $StateDirectory).Path
$launch = Join-Path $state 'run.vbs'
$quotedNode = $NodeExecutable.Replace('"','""')
$quotedWorker = $worker.Replace('"','""')
$quotedState = $state.Replace('"','""')
$vbs = @"
Set shell = CreateObject("WScript.Shell")
shell.Environment("Process")("CLAUDEX_USAGE_HOME") = "$quotedState"
result = shell.Run("""$quotedNode"" ""$quotedWorker""", 0, True)
WScript.Quit result
"@
[IO.File]::WriteAllText($launch, $vbs, [Text.Encoding]::Unicode)
$action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\wscript.exe" -Argument "//B //Nologo `"$launch`""
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 30)
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 8) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -Hidden
$principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description 'Read configured software quotas and verify with WorkBuddy DeepSeek every 30 minutes.' -Force | Out-Null
$task = Get-ScheduledTask -TaskName $TaskName
if ($task.Triggers[0].Repetition.Interval -ne 'PT30M') { throw 'Scheduler interval verification failed.' }
@{ taskName=$TaskName; enabled=$true; intervalMinutes=30; installedAt=(Get-Date).ToUniversalTime().ToString('o'); worker=$worker } |
  ConvertTo-Json | Set-Content -Encoding UTF8 -LiteralPath (Join-Path $state 'schedule.json')
Start-ScheduledTask -TaskName $TaskName
Get-ScheduledTaskInfo -TaskName $TaskName | Select-Object TaskName,LastRunTime,NextRunTime,LastTaskResult
