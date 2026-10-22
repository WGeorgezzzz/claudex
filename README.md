# Claudex

Claudex 是面向 Claude Code / WenClaude 的独立桌面工作台，支持跨项目会话、持久消息队列、运行中补充、分支讨论、文件预览、终端和自动监测。也保留 Codex 等提供商入口。

This is an independently maintained, modified version of **CloudCLI UI (https://github.com/siteboon/claudecodeui)**, based on upstream 1.37.5. Original authorship, commit history, and the AGPL-3.0-or-later license and additional notices are preserved. Claudex is not an official OpenAI or Anthropic product.

## 使用

Windows 安装包和校验值见 [Releases](https://github.com/WGeorgezzzz/claudex/releases)。只使用完成安装验收后发布的 `Claudex-<version>-win-x64.exe`。安装包目前未签名。

首次打开创建本地账号。在桌面启动器 **Local Settings → Claude profile** 中填入现有 Claude 配置目录和可选 CLI 路径；连接 WenClaude 时使用其原有配置目录及兼容 `.js` 启动包装器，保留原代理和登录链路。凭据、个人启动脚本和聊天记录不包含在项目或安装包里。

- **Ctrl/⌘+Shift+K** 或侧栏“搜索会话”：跨项目查找和切换。
- **Ctrl/⌘+K**：会话、文件、Git 和常用操作。
- 运行中选择普通排队或发送文字补充；暂停队列只阻止下一条，不中断当前任务。
- 从完整回复开启独立分支；回填主会话只写草稿，不自动发送。
- 聊天文件链接支持预览、本地打开和绝对路径复制。

[Windows 安装及升级](docs/WORKBENCH-WINDOWS.md) · [功能与边界](docs/CODEX-PARITY.zh-CN.md) · [历史验证记录](docs/FORK-VALIDATION.md)

## 从源码运行

需要 Node.js 22、npm 和配置好的模型 CLI。首次启动使用空闲端口和独立数据目录。

```powershell
git clone https://github.com/WGeorgezzzz/claudex.git
cd claudex
npm ci
npm run build
$env:HOST = '127.0.0.1'
$env:SERVER_PORT = '3016'
$env:CLOUDCLI_HOME = "$env:LOCALAPPDATA\Claudex-data"
$env:DATABASE_PATH = "$env:CLOUDCLI_HOME\auth.db"
# 可选：接入已有 WenClaude 配置；CLI 路径由本机实际安装决定。
$env:CLAUDE_CONFIG_DIR = "$env:USERPROFILE\.claude-cc"
# $env:CLAUDE_CLI_PATH = 'C:\path\to\wenclaude-cli.js'
npm run server
```

`cloudcli` CLI 别名及 `CLOUDCLI_*` 环境变量、Workbench 配置文件/存储标识保留兼容。不要把升级后的服务与旧服务同时指向同一个数据库；正在执行的回合仍由原进程管理。

## 开发与验证

```powershell
npm run test:client
npm run typecheck
npm run lint
npm run build
```

后端测试位于 `server/modules/*/tests`，桌面测试位于 `electron/tests`。Windows 安装构建与独立安装验收由 [Claudex Windows installer](.github/workflows/workbench-windows.yml) 执行；模型真实回复与安装验收分开记录。

贡献前阅读 [AGENTS.md](AGENTS.md)。反馈和代码提交请面向本仓库。旧的 `WGeorgezzzz/claudecodeui` 保留为历史归档，旧安装包不会冒充 Claudex 新版本。

## 来源与许可证

Claudex 保留 **CloudCLI UI (https://github.com/siteboon/claudecodeui)** 的原始提交历史、作者和著作权声明。它是明确标识的修改版本，独立维护并通过本仓库发布；GitHub 仓库的独立状态不改变代码来源或许可证。

适用 [AGPL-3.0-or-later 及附加条款](LICENSE)，参见 [NOTICE](NOTICE)。实现中的 Codex 生命周期设计参考见 [固定版本参考说明](docs/CODEX-SOURCE-REFERENCES.md)。
