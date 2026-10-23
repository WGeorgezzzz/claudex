import os from 'node:os';
import path from 'node:path';
import { McpProvider } from '@/modules/providers/shared/mcp/mcp.provider.js';
import { resolveWorkBuddyInstallation } from '@/modules/providers/list/workbuddy/workbuddy-auth.provider.js';
import type { McpScope, ProviderMcpServer, UpsertProviderMcpServerInput } from '@/shared/types.js';
import { readJsonConfig, readObjectRecord, readStringArray, readStringRecord, writeJsonConfig } from '@/shared/utils.js';

/** WorkBuddy settings edit its native MCP files without touching other providers. */
export class WorkBuddyMcpProvider extends McpProvider {
  constructor() { super('workbuddy', ['user', 'project'], ['stdio', 'http', 'sse']); }
  private file(scope: McpScope, workspacePath: string): string {
    if (!resolveWorkBuddyInstallation()) throw new Error('WorkBuddy local account is unavailable for this user.');
    return path.join(scope === 'user' ? path.join(os.homedir(), '.workbuddy-ai') : workspacePath, '.mcp.json');
  }
  protected async readScopedServers(scope: McpScope, workspacePath: string): Promise<Record<string, unknown>> {
    if (!resolveWorkBuddyInstallation()) return {};
    return readObjectRecord((await readJsonConfig(this.file(scope, workspacePath))).mcpServers) ?? {};
  }
  protected async writeScopedServers(scope: McpScope, workspacePath: string, servers: Record<string, unknown>): Promise<void> {
    const file = this.file(scope, workspacePath);
    const config = await readJsonConfig(file);
    await writeJsonConfig(file, { ...config, mcpServers: servers });
  }
  protected buildServerConfig(input: UpsertProviderMcpServerInput): Record<string, unknown> {
    if (input.transport === 'stdio') {
      if (!input.command?.trim()) throw new Error('MCP command is required.');
      return { type: 'stdio', command: input.command, args: input.args ?? [], env: input.env ?? {} };
    }
    if (!input.url?.trim()) throw new Error('MCP URL is required.');
    return { type: input.transport, url: input.url, headers: input.headers ?? {} };
  }
  protected normalizeServerConfig(scope: McpScope, name: string, raw: unknown): ProviderMcpServer | null {
    const config = readObjectRecord(raw);
    if (typeof config?.command === 'string') return { provider: 'workbuddy', scope, name, transport: 'stdio',
      command: config.command, args: readStringArray(config.args), env: readStringRecord(config.env) };
    if (typeof config?.url === 'string') return { provider: 'workbuddy', scope, name,
      transport: config.type === 'sse' ? 'sse' : 'http', url: config.url, headers: readStringRecord(config.headers) };
    return null;
  }
}
