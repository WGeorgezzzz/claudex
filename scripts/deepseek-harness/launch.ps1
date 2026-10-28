param(
 [Parameter(Mandatory=$true)][string]$Launcher,
 [Parameter(Mandatory=$true)][string]$TaskFile,
 [Parameter(Mandatory=$true)][string]$Workspace,
 [string]$SessionId,
 [ValidateSet('rp','tokenhub')][string]$Provider='rp',
 [string]$SelectionPatch
)
$ErrorActionPreference='Stop'
Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1') -ErrorAction Stop
$OutputEncoding=[System.Text.UTF8Encoding]::new($false)
[Console]::InputEncoding=[System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)
if(-not $SelectionPatch){$launchArgs=@{Provider=$Provider;TaskFile=$TaskFile;Workspace=$Workspace};if($SessionId){$launchArgs.SessionId=$SessionId};& $Launcher @launchArgs;exit $LASTEXITCODE}
$nativeRoot=Split-Path -Parent $Launcher
$envName=if($Provider -eq 'rp'){'RP_API_KEY'}else{'TOKENHUB_API_KEY'}
$previousDshHome=$env:DSH_HOME
$secure=Get-Content -LiteralPath (Join-Path $nativeRoot "$Provider.dpapi") | ConvertTo-SecureString
$ptr=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
$result=1
try{
 Set-Item -Path "Env:$envName" -Value ([Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr))
 $env:DSH_HOME=Join-Path $nativeRoot 'home'
 $nativeArgs=@('--profile','headless','--patch',(Join-Path $nativeRoot "$Provider.patch.yml"),'--patch',$SelectionPatch,'--json')
 if($SessionId){$nativeArgs+=@('--session-id',$SessionId)}
 Push-Location -LiteralPath $Workspace
 try{Get-Content -Raw -Encoding UTF8 -LiteralPath $TaskFile | & (Join-Path $nativeRoot 'runtime/node_modules/.bin/dsh.cmd') @nativeArgs -;$result=$LASTEXITCODE}finally{Pop-Location}
}finally{
 [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
 Remove-Item "Env:$envName" -ErrorAction SilentlyContinue
 if($previousDshHome){$env:DSH_HOME=$previousDshHome}else{Remove-Item Env:DSH_HOME -ErrorAction SilentlyContinue}
}
exit $result
