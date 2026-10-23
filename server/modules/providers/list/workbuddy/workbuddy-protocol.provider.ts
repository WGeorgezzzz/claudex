/** Used by the WorkBuddy runtime and history adapter to reject unexecuted native calls leaked as prose. */
export function workBuddyTextProtocolError(text: unknown): string | null {
  if (typeof text !== 'string') return null;
  // A fenced example is ordinary documentation, not a request to execute a tool.
  const prose = text.replace(/(^|\n)[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n[ \t]*\2[^\n]*(?=\n|$)/g, '\n');
  if (!/(?:^|\n)[ \t]*<\|\|DSML\|\|\s+calls>\s*<\|\|DSML\|\|\s+invoke\s+name\s*=/u.test(prose.replaceAll('｜', '|'))) return null;
  return 'WorkBuddy 工具调用格式异常：返回了未执行的调用标记，本轮不能视为完成。请新建会话重试；异常原文已保留在会话记录中。';
}
