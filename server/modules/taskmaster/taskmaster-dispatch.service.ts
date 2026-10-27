import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import { AppError } from '@/shared/index.js';

// --------------------------- DISPATCH CONFIGURATION ------------

/**
 * Trusted administrator-only routing for Taskmaster task execution.
 *
 * `codex-direct` keeps the historical behaviour: the Codex session receives the
 * task prompt and performs the work itself. `gpt-workbuddy` keeps the same
 * Codex session but instructs it to plan and supervise, delegating the actual
 * work to the trusted WorkBuddy launcher. Unknown keys are rejected so a typo
 * cannot silently downgrade routing or smuggle credentials into the config.
 */
const dispatchConfigSchema = z.object({
  mode: z.enum(['codex-direct', 'gpt-workbuddy']),
  launcher: z.string().trim().min(1).optional(),
  controlRoot: z.string().trim().min(1).optional(),
}).strict();

/** Resolved routing config, private to this module; consumers only see the routing plan. */
type TaskmasterDispatchConfig = z.infer<typeof dispatchConfigSchema>;

type PathKind = 'file' | 'directory' | 'other' | 'missing';

function invalidConfig(reason: string): never {
  throw new AppError(`Taskmaster 调度配置无效：${reason}`, { code: 'TASKMASTER_DISPATCH_CONFIG_INVALID', statusCode: 500 });
}

async function inspectPathType(target: string): Promise<PathKind> {
  try {
    const info = await fs.promises.stat(target);
    return info.isFile() ? 'file' : info.isDirectory() ? 'directory' : 'other';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    throw error;
  }
}

/**
 * Reads the trusted dispatch config on every new task execution.
 *
 * Returns `undefined` only when the file does not exist, which means the caller
 * keeps the unchanged Codex behaviour. A present but unreadable, malformed, or
 * inconsistent config throws instead of falling back, so an administrator who
 * requested WorkBuddy delegation never silently gets direct execution. Callers
 * must not pass user-controlled paths or credentials here.
 */
export async function loadTaskmasterDispatchConfig(options: {
  env?: NodeJS.ProcessEnv;
  homeDirectory?: string;
  readTextFile?: (filePath: string) => Promise<string>;
  inspectPath?: (target: string) => Promise<PathKind>;
} = {}): Promise<TaskmasterDispatchConfig | undefined> {
  const env = options.env ?? process.env;
  const filePath = path.resolve(env.TASKMASTER_DISPATCH_CONFIG
    || path.join(options.homeDirectory ?? os.homedir(), '.cloudcli', 'taskmaster-dispatch.json'));
  const readTextFile = options.readTextFile ?? (target => fs.promises.readFile(target, 'utf8'));
  const inspectPath = options.inspectPath ?? inspectPathType;

  let raw: string;
  try {
    raw = await readTextFile(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    invalidConfig(`无法读取 ${filePath}：${error instanceof Error ? error.message : String(error)}`);
  }

  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { invalidConfig(`${filePath} 不是合法的 JSON。`); }

  const result = dispatchConfigSchema.safeParse(parsed);
  if (!result.success) {
    invalidConfig(`${filePath} 字段不符合要求：${result.error.issues
      .map(issue => `${issue.path.join('.') || '(root)'} ${issue.message}`).join('; ')}`);
  }
  const config = result.data;
  if (config.mode !== 'gpt-workbuddy') return config;

  // WorkBuddy delegation needs concrete absolute targets, verified before any
  // session exists so a bad config cannot start an unroutable execution.
  for (const [key, expected] of [['launcher', 'file'], ['controlRoot', 'directory']] as const) {
    const value = config[key];
    if (!value) invalidConfig(`gpt-workbuddy 模式需要 ${key}。`);
    if (!path.isAbsolute(value)) invalidConfig(`${key} 必须是绝对路径：${value}`);
    let actual: PathKind;
    try { actual = await inspectPath(value); }
    catch (error) {
      invalidConfig(`无法检查 ${key} ${value}：${error instanceof Error ? error.message : String(error)}`);
    }
    if (actual === 'missing') invalidConfig(`${key} 不存在：${value}`);
    if (actual !== expected) invalidConfig(`${key} 必须是${expected === 'file' ? '文件' : '目录'}：${value}`);
  }
  return config;
}

// --------------------------- DISPATCH PLANNING ------------

/**
 * Planner instructions prepended to the existing task prompt in gpt-workbuddy
 * mode. The Codex session stays the planner/supervisor; every mutation of the
 * project must go through the trusted WorkBuddy launcher so the receipt and
 * transcript of each run remain independently inspectable.
 */
function plannerInstructions(input: { launcher: string; controlRoot: string; projectRoot: string; runId: string }): string {
  const taskFile = path.join(input.controlRoot, input.runId, 'task.txt');
  const runDirectory = path.join(input.controlRoot, input.runId, 'run-001');
  return `【调度方式：GPT-6 规划 + WorkBuddy 执行】
你是本任务的规划与监督者，负责规划、检查与验收，不直接实施改动。请按以下流程执行：
1. 先按需规划、阅读代码和检查环境，确认改动范围、验收标准与风险。
2. 在 ${path.join(input.controlRoot, input.runId)} 下创建一个聚焦本次任务的 .txt 任务说明文件（目录不存在时先创建），例如 ${taskFile}，写清目标、范围、验收标准和注意事项。
3. 使用 Node 调用受信任的 WorkBuddy 启动器执行实际工作，命令形如：
   node "${input.launcher}" --task-file "${taskFile}" --cwd "${input.projectRoot}" --out "${runDirectory}"
   首次运行使用 run-001；后续每次重试必须使用 run-002、run-003 或其他全新的目录名，不得复用、覆盖或写入已有运行目录。
4. 实际实现和所有操作必须交给 WorkBuddy；你可以独立读取和检查它产生的结果。
5. 运行后读取该运行目录下的 receipt.json 和 transcript.jsonl。receipt 成功只代表运行时收据，必须自行核对任务产物（文件内容、命令输出、测试结果）后才能判断任务是否完成。
6. 如果执行失败：如实报告失败原因，不得声称任务已完成，也不得改用 Claude 或 Codex 自行执行；可以整理修正后的说明，并使用 --resume <session> 搭配全新的 --out 目录重试。
7. 不要重复派发已在执行中的任务，也不要修改、接管或中断其他活动会话。
8. 任务说明文件、命令行和日志中不得写入任何凭据、密钥、令牌或登录信息。
最终汇报必须以你独立核验的证据为准，并列出产出路径与未完成部分。`;
}

/** Routing decision for one new execution; the Codex provider itself never changes. */
type TaskmasterDispatchPlan =
  | { mode: 'codex-direct' }
  | { mode: 'gpt-workbuddy'; launcher: string; controlRoot: string; runId: string; instructions: string };

/**
 * Decides how a new task execution is routed.
 *
 * Only administrators can opt into gpt-workbuddy; every other role keeps the
 * historical Codex behaviour without even reading the config file. The config
 * loader is injected so tests never touch a developer's home directory.
 */
export async function planTaskmasterDispatch(options: {
  role: string | undefined;
  projectRoot: string;
  loadConfig?: () => Promise<TaskmasterDispatchConfig | undefined>;
  createRunId?: () => string;
}): Promise<TaskmasterDispatchPlan> {
  if (options.role !== 'admin') return { mode: 'codex-direct' };
  const config = await (options.loadConfig ?? loadTaskmasterDispatchConfig)();
  if (!config || config.mode === 'codex-direct') return { mode: 'codex-direct' };
  if (!config.launcher || !config.controlRoot) {
    invalidConfig('gpt-workbuddy 模式需要 launcher 与 controlRoot。');
  }
  const runId = (options.createRunId ?? randomUUID)();
  return { mode: 'gpt-workbuddy', launcher: config.launcher, controlRoot: config.controlRoot, runId,
    instructions: plannerInstructions({ launcher: config.launcher, controlRoot: config.controlRoot,
      projectRoot: options.projectRoot, runId }) };
}
