import path from 'node:path';

export const name = 'workspace-search-guard';
export const inject = ['tools', 'workingDirectory'];

// Installed only for explicitly configured multi-project roots. Project searches
// keep upstream glob semantics, including ignored files and recursive patterns.
export function apply(ctx, config) {
  const roots = config.roots.map(root => path.resolve(root).toLowerCase());
  ctx.on('tools/execute', async (exec, next) => {
    if (exec.name !== 'glob') return next();
    const args = exec.arguments;
    if (!args || typeof args.pattern !== 'string') return next();
    const cwd = exec.agent ? await ctx.workingDirectory.ensure(exec.agent, exec.signal) : process.cwd();
    const root = path.resolve(cwd, typeof args.path === 'string' ? args.path : '.');
    if (!roots.includes(root.toLowerCase())) return next();
    const message = `Search scope too broad: ${root} is a multi-project workspace. No recursive search was run. List its immediate directories with a non-recursive shell command (PowerShell: Get-ChildItem -LiteralPath '${root.replaceAll("'", "''")}' -Directory -Name), then call glob with path set to the relevant project directory. Do not repeat glob at this root.`;
    return { isError: true, content: [{ type: 'text', text: message }],
      error: { message, info: { name: 'SearchScopeError', code: 'SEARCH_SCOPE_TOO_BROAD' } } };
  });
}
