const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/** Session creation and title tests share the immediate, bounded placeholder. */
export function buildTemporaryTitle(message: string, language = 'zh'): string {
  const clean = message.replace(/```[^]*?(?:```|$)/g, '').replace(/~~~[^]*?(?:~~~|$)/g, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/gi, '').replace(/[#*_`>~|\[\]]/g, '');
  const line = clean.split(/\r?\n/).map(value => value.replace(/^\s*(?:[-+]\s+|\d+[.)]\s+)/, '').trim()).find(Boolean)?.replace(/\s+/g, ' ') ?? '';
  if (!line) return language.startsWith('en') ? 'New chat' : '新对话';
  const units = CJK.test(line) ? Array.from(line) : line.split(' ');
  const limit = CJK.test(line) ? 16 : 6;
  return units.slice(0, limit).join(CJK.test(line) ? '' : ' ') + (units.length > limit ? '…' : '');
}

/** Provider generation and tests reject malformed structured titles before persistence. */
export function validateSessionTitle(value: unknown): string {
  const title = (value as { title?: unknown })?.title;
  if (typeof title !== 'string' || title !== title.trim() || /[\r\n"“”‘’「」。.!！?？]|^(?:帮我|请)|对话|会话/i.test(title)) throw new Error('Invalid generated title');
  const length = CJK.test(title) ? Array.from(title).length : title.split(/\s+/).length;
  if (CJK.test(title) ? length < 6 || length > 16 : length < 2 || length > 6) throw new Error('Invalid generated title length');
  return title;
}
