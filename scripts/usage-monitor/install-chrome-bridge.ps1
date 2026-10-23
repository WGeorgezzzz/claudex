param(
  [string]$StateDirectory = (Join-Path $env:USERPROFILE '.cloudcli\provider-usage'),
  [string]$NodeExecutable = 'C:\Program Files\nodejs\node.exe'
)
$ErrorActionPreference = 'Stop'
$bridge = Join-Path $PSScriptRoot 'chrome-bridge.cjs'
$env:CLAUDEX_USAGE_HOME = $StateDirectory
& $NodeExecutable $bridge --prepare
if ($LASTEXITCODE -ne 0) { throw 'Could not prepare the Chrome quota bridge.' }
$state = (Resolve-Path -LiteralPath $StateDirectory).Path
$launcher = Join-Path $state 'chrome-bridge.vbs'
$quotedNode = $NodeExecutable.Replace('"','""')
$quotedBridge = $bridge.Replace('"','""')
$quotedState = $state.Replace('"','""')
$vbs = @"
Set shell = CreateObject("WScript.Shell")
shell.Environment("Process")("CLAUDEX_USAGE_HOME") = "$quotedState"
result = shell.Run("""$quotedNode"" ""$quotedBridge""", 0, True)
WScript.Quit result
"@
[IO.File]::WriteAllText($launcher, $vbs, [Text.Encoding]::Unicode)
$user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\wscript.exe" -Argument "//B //Nologo `"$launcher`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -Hidden
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName 'GACI-Chrome-Quota-Bridge' -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description 'Receive only validated wenClaude quota snapshots on localhost.' -Force | Out-Null
Start-ScheduledTask -TaskName 'GACI-Chrome-Quota-Bridge'
Get-ScheduledTaskInfo -TaskName 'GACI-Chrome-Quota-Bridge' | Select-Object TaskName,LastRunTime,LastTaskResult
