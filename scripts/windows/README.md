# Hidden Windows scheduled jobs

Use this launcher for non-interactive console programs started by Windows Task
Scheduler. A hidden inner `spawn()` cannot remove a console already created by
the scheduled PowerShell or Node entrypoint. This GUI-subsystem launcher starts
that outer process with `CreateNoWindow` and waits for its real exit code.

Build from a Windows checkout with Node and the Windows .NET Framework compiler:

```powershell
node scripts/windows/build-hidden-launcher.mjs C:\Claudex-tools\ClaudexHidden.exe
powershell.exe -NoProfile -File scripts/windows/Set-HiddenScheduledTask.ps1 `
  -TaskName 'my-background-job' `
  -Launcher C:\Claudex-tools\ClaudexHidden.exe `
  -ConfigDirectory C:\Claudex-tools\jobs
```

The helper accepts an existing task with one PowerShell, Node, cmd or Codex
action. It exports the original task XML and stores the executable, raw argument
string and working directory in a JSON file before changing the action. It does
not stop or start the task. Existing processes and their windows remain as they
are; the replacement applies on the next invocation. Keep the launcher and JSON
files in their configured locations.

The original arguments are passed directly without an extra command shell or
environment-variable expansion. Environment inheritance and the scheduled task's
principal, triggers and settings are retained. The launcher does not capture logs:
keep redirection or file logging in the original command. Startup failures append
to `<config>.error.log` when writable and return exit code 1.

If a task is later recreated with a direct console action, apply the helper again
using a fresh backup directory. To restore the original definition, wait until
the task is idle and use its saved XML with `Register-ScheduledTask`. This helper
does not suppress windows explicitly created by child applications and is not
intended for interactive terminals or commands requiring keyboard input.
