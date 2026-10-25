# Desktop profiles and upgrades

Nexagent installers include a separate Node.js 22 runtime, backend, native modules,
and frontend. First launch does not need to download a separately published server.

| Platform | Default profile |
| --- | --- |
| Windows | `%APPDATA%\CloudCLI Workbench` |
| macOS | `~/Library/Application Support/CloudCLI Workbench` |
| Linux | `$XDG_CONFIG_HOME/CloudCLI Workbench` or `~/.config/CloudCLI Workbench` |

The profile owns `server/auth.db`, browser sessions, desktop settings, and its
installation ID. The preferred backend port is 3016, with a free-port fallback.
Existing unrelated services are never joined. An older backend owning the same
profile must finish its work and be stopped before an upgrade can use that profile.
Uninstalling retains application data. Back up the profile before upgrading.

For isolated evaluation, set `WORKBENCH_USER_DATA_DIR` to a new absolute directory.
Agent authentication is separate from the Nexagent administrator. The bundled
Claude CLI starts with the profile's `providers/claude` configuration; sign in or
select your existing configuration in desktop settings. Other local agents are
detected from PATH and supported installation locations.

Compatibility identifiers remain unchanged: app ID
`io.github.wgeorgezzzz.cloudcli-workbench`, protocol `cloudcli-workbench://`, and
storage folder `CloudCLI Workbench`. The thin-shell compatibility app ID
`ai.cloudcli.desktop` and `cloudcli://` are also retained in source.

Windows builds are unsigned. macOS builds are unsigned and not notarized; use
Privacy & Security's Open Anyway only after verifying the source and checksum.
Linux archives require a graphical session and the platform's normal Electron
runtime libraries. Linux and macOS build success does not establish every desktop
environment's runtime compatibility.
