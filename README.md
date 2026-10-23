# GACI

**General Agent Cloud Integration** · **Your agents, one workspace.**

GACI 是统一的 Agent 工作台，连接本地与云端的 Claude、Codex、Cursor、OpenCode 和 WorkBuddy，提供跨项目会话、持久消息队列、分支讨论、文件预览与终端。不同提供商的能力以实际接入为准。

This is an independently maintained, modified version of **CloudCLI UI (https://github.com/siteboon/claudecodeui)**, based on upstream 1.37.5. Original authorship, commit history, and the AGPL-3.0-or-later license and additional notices are preserved. GACI is not an official OpenAI or Anthropic product.

## 使用

Windows 安装包和校验值见 [Releases](https://github.com/WGeorgezzzz/claudex/releases)。新构建命名为 `GACI-<version>-win-x64.exe`，只使用完成安装验收后发布的安装包；旧发布仍可能使用 Claudex 名称。安装包目前未签名。

桌面端默认使用本机操作系统身份登录，无需另建用户名和密码；已有本地账号及数据继续保留。在桌面启动器 **Local Settings → Claude profile** 中填入现有 Claude 配置目录和可选 CLI 路径。凭据、个人启动脚本和聊天记录不包含在项目或安装包里。

- **Ctrl/⌘+Shift+K** 或侧栏“搜索会话”：跨项目查找和切换。
- 侧栏 **Dot**：独立个人对话、可编辑记忆、跨项目委派和活动回执。用户明确要求后才保存记忆或委派，完成结果自动回报原对话；模型回合结束不等于实际目标验收通过。
- 侧栏底部 **账号与设备**：查看并撤销登录会话。远程完整工作台可单独配置 Cloudflare Access、独立密码及 TOTP；默认不开放公网入口，见 [远程接入说明](docs/PRIVATE-ACCESS.md)。
- 侧栏 **会话收件箱**：集中筛选未读、待处理和置顶会话；按标题、项目路径或提供商搜索，快捷置顶、标记已读。批量已读只作用于当前筛选，处理期间新到达的结果保留未读。
- **Ctrl/⌘+K**：会话、文件、Git 和常用操作。
- 界面采用紧凑侧栏、单行聊天标题、居中阅读区和底部输入框；附件、命令、监测和跨会话入口在输入框的 **＋** 菜单，模型在框内，权限和上下文用量在框下。
- 顶部图标打开文件、终端、变更或浏览器；右侧面板可独立关闭并调整宽度。显示选项在右上角，快捷设置在侧栏底部。没有待处理项时消息队列只保留折叠记录。
- 运行中选择普通排队或发送文字补充；暂停队列只阻止下一条，不中断当前任务。
- 从完整回复开启独立分支；回填主会话只写草稿，不自动发送。
- 聊天文件链接支持预览、本地打开和绝对路径复制。
- 侧栏工作区分组：创建、重命名、排序、折叠分组，归入项目或单个会话；按账号保存。
- 跨会话面板支持搜索、阅读、引用到草稿和明确发送；Claude 也可通过会话工具读取上下文，并在用户授权后投递消息、查询回执。
- Claude 完成回复后自动生成下一步提示词；点击只填入草稿，由用户决定是否发送。
- 自动监测支持间隔、每天或每周指定时间及 IANA 时区；忙时等待，失败按 1、2、4、8、16、30 分钟退避自动重试，后续最多每 30 分钟重试。服务重启保留重试计划，手动暂停和停止保持不变。

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
# 可选：接入已有 Claude 配置；CLI 路径由本机实际安装决定。
$env:CLAUDE_CONFIG_DIR = "$env:USERPROFILE\.claude"
# $env:CLAUDE_CLI_PATH = 'C:\path\to\claude.exe'
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

后端测试位于 `server/modules/*/tests`，桌面测试位于 `electron/tests`。Windows 安装构建与独立安装验收由 [GACI Windows installer](.github/workflows/workbench-windows.yml) 执行；模型真实回复与安装验收分开记录。

贡献前阅读 [AGENTS.md](AGENTS.md)。反馈和代码提交请面向本仓库。旧的 `WGeorgezzzz/claudecodeui` 保留为历史归档，旧安装包不会冒充 GACI 新版本。

## 来源与许可证

GACI 保留 **CloudCLI UI (https://github.com/siteboon/claudecodeui)** 的原始提交历史、作者和著作权声明。它是明确标识的修改版本，独立维护并通过本仓库发布；GitHub 仓库的独立状态不改变代码来源或许可证。

适用 [AGPL-3.0-or-later 及附加条款](LICENSE)，参见 [NOTICE](NOTICE)。实现中的 Codex 生命周期设计参考见 [固定版本参考说明](docs/CODEX-SOURCE-REFERENCES.md)。
