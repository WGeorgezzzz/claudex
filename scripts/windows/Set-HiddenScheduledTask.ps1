param(
    [Parameter(Mandatory=$true)][string]$TaskName,
    [Parameter(Mandatory=$true)][string]$Launcher,
    [Parameter(Mandatory=$true)][string]$ConfigDirectory,
    [string]$TaskPath='\'
)
$ErrorActionPreference='Stop'
$launcherPath=(Resolve-Path -LiteralPath $Launcher).Path
$directory=[IO.Path]::GetFullPath($ConfigDirectory)
$task=Get-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath
if(@($task.Actions).Count -ne 1){throw 'Only one-action console tasks are supported.'}
$old=$task.Actions[0]
if($old.Execute -eq $launcherPath){Write-Output 'This task already uses the hidden launcher.';exit 0}
if([IO.Path]::GetFileName($old.Execute) -notin @('pwsh.exe','powershell.exe','node.exe','cmd.exe','codex.exe')){throw 'The task does not directly launch a supported console program.'}
New-Item -ItemType Directory -Path $directory -Force | Out-Null
$name=($TaskPath+$TaskName) -replace '[^a-zA-Z0-9_.-]','_'
$config=Join-Path $directory ($name+'.json')
$backup=Join-Path $directory ($name+'.before.xml')
if((Test-Path -LiteralPath $config) -or (Test-Path -LiteralPath $backup)){throw 'A previous configuration/backup exists; inspect it before replacing this task.'}
Export-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath | Set-Content -LiteralPath $backup -Encoding utf8
@{FilePath=$old.Execute;Arguments=$old.Arguments;WorkingDirectory=$old.WorkingDirectory} | ConvertTo-Json | Set-Content -LiteralPath $config -Encoding utf8
$action=New-ScheduledTaskAction -Execute $launcherPath -Argument ('"'+$config+'"')
if($old.WorkingDirectory){$action.WorkingDirectory=$old.WorkingDirectory}
# Updating the definition applies to the next invocation. Do not stop or start this task here.
Set-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -Action $action | Select-Object TaskName,State
