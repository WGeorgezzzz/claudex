/** GlobalTasksPage groups fine-grained tasks without merging their records or statuses. */
export const TASK_WORKSTREAMS = [
  { id: 'robotics', name: '机器人与现场', description: '真机部署、遥操、硬件与现场问题', accent: 'bg-blue-500' },
  { id: 'research', name: '仿真与研究', description: '仿真数据、模型评测、实验与复现', accent: 'bg-violet-500' },
  { id: 'platform', name: '工作台与基础设施', description: 'Nexagent、开发工具、服务器与存储', accent: 'bg-emerald-500' },
  { id: 'delivery', name: '合作与交付', description: '客户会议、材料、宣发与团队协作', accent: 'bg-amber-500' },
  { id: 'followup', name: '跟进与整理', description: '其他待办、文档核对与后续跟进', accent: 'bg-slate-400' },
] as const;

/** Title-first rules keep a tool mentioned in a task from becoming its owning workstream. */
export function taskWorkstream(title: string, projectName = ''): (typeof TASK_WORKSTREAMS)[number]['id'] {
  const classify = (text: string) => {
    if (/会议|宣发|宣传|规格书|\bbom\b|入职|新同事|工作组申请|对外|影溯|客户.*沟通|会前|会后/i.test(text)) return 'delivery' as const;
    if (/nexagent|claudex|taskmaster|侧栏|会话|工作台|命令行弹窗|workbuddy|antigravity|harness|登录|账号|\bssh\b|\bnas\b|免密|git.*身份|快捷方式|[\[【]测试[\]】]/i.test(text)) return 'platform' as const;
    if (/\brpw\d?\b|\bcatl\b|\bpico\b|机器人|真机部署|遥操|伺服|电机|硬件|相机.*故障/i.test(text)) return 'robotics' as const;
    if (/\bras\b|\brax\b|intact|real2sim|sim2real|libero|skillagent|skillbench|aspire|pyrua|robodojo|qwen|仿真|测评|评测|数据集|实验|复现|方巾|折叠|规划模型|技能库|标定|训练|论文/i.test(text)) return 'research' as const;
    if (/服务器|存储|备份|数据清理|git(hub)?|打包|上线|部署入口/i.test(text)) return 'platform' as const;
    return null;
  };
  return classify(title) || classify(projectName) || 'followup';
}
