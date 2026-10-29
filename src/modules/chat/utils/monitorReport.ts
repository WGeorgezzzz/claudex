/** Remove the monitor control protocol from user-facing reports, including truncated output.
 * Fenced examples are documentation, not control messages. Raw provider history is retained.
 */
export function cleanMonitorReport(text: string): string {
  const strip = (value: string) => {
    value=value.replace(/<monitor-(state|probe|meta)>[\s\S]*?(?:<\/monitor-\1>|$)/gi, '');
    for(const tag of ['<monitor-state>','<monitor-probe>','<monitor-meta>'])
      for(let n=2;n<tag.length;n++)if(value.toLowerCase().endsWith(tag.slice(0,n)))return value.slice(0,-n);
    return value;
  };
  const fences = /^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^[ \t]*\1[ \t]*(?:\n|$)/gm;
  let result = '', offset = 0;
  for (const match of text.matchAll(fences)) {
    result += strip(text.slice(offset, match.index)) + match[0];
    offset = match.index! + match[0].length;
  }
  return (result + strip(text.slice(offset))).trim();
}
