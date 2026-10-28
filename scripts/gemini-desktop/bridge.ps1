param([ValidateSet('Inspect','Run')][string]$Operation='Inspect',[string]$InputFile)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;using System.Runtime.InteropServices;
public class GeminiDesktopWindow{[DllImport("user32.dll")]public static extern bool ShowWindow(IntPtr h,int c);[DllImport("user32.dll")]public static extern bool SetForegroundWindow(IntPtr h);}
"@
function Root {
 $p=Get-Process Gemini -ErrorAction SilentlyContinue | Where-Object {$_.MainWindowHandle -ne 0 -and $_.Path -like '*\Google\Gemini\*'} | Select-Object -First 1
 if(!$p){throw '请先打开并登录 Gemini 桌面版'}
 return [System.Windows.Automation.AutomationElement]::FromHandle($p.MainWindowHandle)
}
function Elements($root,$type){return $root.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty,$type))}
function Value($element){return ([System.Windows.Automation.ValuePattern]$element.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)).Current.Value}
function Invoke($element){([System.Windows.Automation.InvokePattern]$element.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)).Invoke()}
function Buttons($root){return @(Elements $root ([System.Windows.Automation.ControlType]::Button))}
function Model($root){foreach($b in (Buttons $root)){if($b.Current.Name -match '当前模式为[“"](.+?)[”"]'){return $Matches[1]}};throw '未发现 Gemini 当前模型，请先在桌面版选择模型'}
function Busy($root){return @((Buttons $root) | Where-Object {$_.Current.Name -match '^(停止|Stop)'}).Count -gt 0}
function Links($root){$all=@();foreach($l in (Elements $root ([System.Windows.Automation.ControlType]::Hyperlink))){try{$url=Value $l;if($url -match '^https://gemini\.google\.com/app(?:/[a-zA-Z0-9_-]+)?$'){$all+=@{url=$url;element=$l}}}catch{}};return $all}
function Input($root){return $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty,[System.Windows.Automation.ControlType]::Edit))}
function OwnsTurn($root,$message){foreach($node in (Elements $root ([System.Windows.Automation.ControlType]::Text))){if(([string]$node.Current.Name).Trim() -eq $message.Trim()){return $true}};return $false}
function Reply($root,$marker){
 $nodes=$root.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition);$at=-1;$found=$false
 for($i=0;$i -lt $nodes.Count;$i++){if(([string]$nodes[$i].Current.Name).Trim() -eq $marker){$found=$true};if($found -and $nodes[$i].Current.Name -in @('Gemini 说','Gemini said')){$at=$i}}
 if($at -lt 0){return ''};$parts=@()
 for($i=$at+1;$i -lt $nodes.Count;$i++){$n=$nodes[$i].Current;if($n.ControlType -eq [System.Windows.Automation.ControlType]::Button -and $n.Name -in @('复制','Copy')){break};if($n.ControlType -eq [System.Windows.Automation.ControlType]::Text -and ([string]$n.Name).Trim()){$parts+=$n.Name}}
 return ($parts -join "`n").Trim()
}
try{
 $root=Root;$model=Model $root
 if($Operation -eq 'Inspect'){@{model=$model;authenticated=$true;busy=(Busy $root);transport='desktop-uia'} | ConvertTo-Json -Compress;exit 0}
 $request=Get-Content -LiteralPath $InputFile -Raw -Encoding UTF8 | ConvertFrom-Json
 $mutex=[Threading.Mutex]::new($false,'Local\NexagentGeminiDesktop');$owned=$false
 try{
  try{$owned=$mutex.WaitOne(0)}catch [Threading.AbandonedMutexException]{$owned=$true}
  if(!$owned){throw 'Gemini 桌面桥接正被另一进程使用'}
  if(Busy $root){throw 'Gemini 桌面版正在生成，请等待结束后重试'}
  $draft=Value (Input $root)
  if($draft.Trim() -notin @('','描述任务','接着提问','问问 Gemini','为 Gemini 输入提示','Ask Gemini','向 Gemini 提问')){throw 'Gemini 桌面版有未发送草稿，已保留，请先处理草稿'}
  if($model -ne $request.model){throw 'Gemini 桌面当前模型已改变，请刷新模型列表'}
  $linksBefore=Links $root;$urlsBefore=@($linksBefore | ForEach-Object {$_.url})
  $target=if($request.nativeId){'https://gemini.google.com/app/'+$request.nativeId}else{'https://gemini.google.com/app'}
  $link=$linksBefore | Where-Object {$_.url -eq $target} | Select-Object -First 1
  if(!$link){throw '原生会话不在侧栏，请在 Gemini 桌面打开该会话后重试'}
  Invoke $link.element
  Start-Sleep -Milliseconds 700
  $root=Root;$edit=Input $root
  if((Model $root) -ne $request.model){throw '原生会话模型与所选模型不一致，未发送提示'}
  if(Busy $root){throw '目标 Gemini 会话正在生成，未发送提示'}
  $targetDraft=Value $edit
  if($targetDraft.Trim() -notin @('','描述任务','接着提问','问问 Gemini','为 Gemini 输入提示','Ask Gemini','向 Gemini 提问')){throw '目标会话有未发送草稿，已保留'}
  [GeminiDesktopWindow]::ShowWindow([IntPtr]$root.Current.NativeWindowHandle,9) | Out-Null
  [GeminiDesktopWindow]::SetForegroundWindow([IntPtr]$root.Current.NativeWindowHandle) | Out-Null
  $marker="[Nexagent session $($request.sessionId) turn $([Guid]::NewGuid().ToString())]"
  $message=$marker+"`n"+$request.prompt
  ([System.Windows.Automation.ValuePattern]$edit.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)).SetValue($message)
  $edit.SetFocus();[System.Windows.Forms.SendKeys]::SendWait(' ')
  $send=$null;for($i=0;$i -lt 30;$i++){$send=(Buttons (Root)) | Where-Object {$_.Current.Name -in @('发送','Send message','Send')} | Select-Object -First 1;if($send){break};Start-Sleep -Milliseconds 100}
  if(!$send){throw 'Gemini 发送按钮未就绪'};Invoke $send
  $last='';$stable=0;$deadline=[DateTime]::UtcNow.AddMinutes(5)
  while([DateTime]::UtcNow -lt $deadline){Start-Sleep -Milliseconds 1000;$root=Root
   if(!(OwnsTurn $root $marker)){throw '桌面已切换离开本轮会话，停止读取；请在原生应用确认本轮状态'}
   if(Test-Path -LiteralPath ($InputFile+'.stop')){$stop=(Buttons $root) | Where-Object {$_.Current.Name -match '^(停止|Stop)'} | Select-Object -First 1;if($stop){Invoke $stop};throw '本轮已取消，原生会话已保留'}
   $text=Reply $root $marker;$copy=@((Buttons $root) | Where-Object {$_.Current.Name -in @('复制','Copy')}).Count -gt 0
   if($text -and $text -eq $last -and !(Busy $root) -and $copy){$stable++}else{$stable=0};$last=$text
   if($stable -ge 2){$nativeId=$request.nativeId;if(!$nativeId){$new=(Links $root) | Where-Object {$_.url -notin $urlsBefore} | Select-Object -First 1;if($new){$nativeId=$new.url.Split('/')[-1]}};if(!$nativeId){throw '未能确认原生会话链接，未伪造会话ID'};@{response=$text;nativeId=$nativeId;model=$model;transport='desktop-uia'} | ConvertTo-Json -Compress;exit 0}
  };throw 'Gemini 桌面回复超时，原生会话已保留'
 }finally{if($owned){$mutex.ReleaseMutex()};$mutex.Dispose()}
}catch{[Console]::Error.WriteLine($_.Exception.Message+" (bridge line "+$_.InvocationInfo.ScriptLineNumber+")");exit 1}
