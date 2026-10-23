# WorkBuddy 本地登录接入

Claudex 可调用同一台 Windows 电脑上已安装的 WorkBuddy 官方 CLI，并复用桌面端登录。新建对话时选择 **WorkBuddy → WorkBuddy Fast**。设置 → 智能体 → WorkBuddy 显示本地登录状态；失效时在 WorkBuddy 桌面端重新登录，再刷新状态。

当前接入支持新建对话、续聊、历史读回和停止。附件、工具执行、MCP、技能、分叉和消息编辑尚未接入，因此不显示这些能力。WorkBuddy 的原始桌面会话不会被导入或修改。普通成员不能使用管理员的本机 WorkBuddy 登录。

预设提供 Fast、Balanced、Powerful 和 Deep 模式，默认 Fast。模型目录可见不代表账号有权调用：上游返回的权限、额度和登录错误会保留为失败，即使官方 CLI 退出码为 0。2026-10-23 的本机验证中，Fast 可用，直接指定 GPT-5.6-Luna 返回 `personal_free_user` 权限限制；其他模式尚未逐一实测。

运行时从安装目录发现官方程序和产品配置。非标准安装位置可设置 `WORKBUDDY_INSTALL_DIR`。目前支持包含 `codebuddy-lite-wb.mjs` 的 Windows WorkBuddy 安装；不支持的版本明确报告未安装或登录不可用。升级客户端后应重新做真实请求验证。

凭证只在官方 Electron 子进程内解密，并通过官方 `CODEBUDDY_AUTH_TOKEN` 配置供内置 CLI 使用；不导出令牌、不复制登录文件、不改写原登录状态。会话记录放在 Claudex 数据目录的 `workbuddy/transcripts`，以应用会话 ID 隔离。原生 CLI 仍负责它自身的会话续聊存储。

直接请求聊天 API 的试验被官方通道校验拒绝，最终实现使用官方 CLI，不运行第三方反向代理，不改写提示词或模拟设备校验。

参考：[官方无界面运行文档](https://www.codebuddy.ai/docs/cli/headless)、[官方环境变量文档](https://www.codebuddy.ai/docs/cli/env-vars)。本地加密封装的兼容实现参考了 MIT 许可项目 [wb2api 的凭证解码实现](https://github.com/jzh-1228/wb2api/blob/master/admin/credential_codec.py)，实际密钥由用户已安装的 WorkBuddy 运行时提供。
