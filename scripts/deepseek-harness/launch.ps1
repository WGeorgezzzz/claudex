param(
    [Parameter(Mandatory = $true)][string]$Launcher,
    [Parameter(Mandatory = $true)][string]$TaskFile,
    [Parameter(Mandatory = $true)][string]$Workspace,
    [string]$SessionId
)
$ErrorActionPreference = 'Stop'
# Use this engine's built-in module even when a PowerShell 7 parent supplied PSModulePath.
Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1') -ErrorAction Stop
# Windows PowerShell otherwise replaces non-ASCII prompt text with '?'
# when the installed launcher pipes its UTF-8 task file into the native CLI.
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$launchArgs = @{ Provider = 'rp'; TaskFile = $TaskFile; Workspace = $Workspace }
if ($SessionId) { $launchArgs.SessionId = $SessionId }
& $Launcher @launchArgs
exit $LASTEXITCODE
