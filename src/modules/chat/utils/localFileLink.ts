import { defaultUrlTransform } from 'react-markdown';

/** Standalone inline-code filenames can be opened; commands and executable URL schemes stay literal. */
export function isInlineFileReference(value:string): boolean {
  const ref=value.trim();
  if(!ref || /[\r\n<>|;&]/.test(ref))return false;
  if(/^file:\/\//i.test(ref))return Boolean(localFileUrlTransform(ref));
  const absolute=/^(?:[a-z]:[\\/]|\/)/i.test(ref);
  const relative=/^(?:\.{1,2}[\\/]|[^\s:]+[\\/])/.test(ref);
  const filename=/^[^\s:/\\]+\.[a-z0-9]{1,12}(?::\d+(?::\d+)?)?$/i.test(ref);
  return (absolute||relative||filename) && /\.[a-z0-9]{1,12}(?::\d+(?::\d+)?)?$/i.test(ref);
}

/** Chat Markdown and its tests use this transform to preserve local paths without admitting executable URL schemes. */
export function localFileUrlTransform(url: string): string {
  // CommonMark percent-encodes backslashes in Windows drive destinations.
  if (/^[a-z]:(?:%5c|%2f)/i.test(url)) return url.replace(/%5c|%2f/gi, '/');
  if (/^[a-z]:[\\/]/i.test(url) || /^\/[a-z]:\//i.test(url)) return url;
  if (/^file:\/\//i.test(url)) {
    try { const parsed=new URL(url); return !parsed.hostname || parsed.hostname==='localhost' ? url : ''; }
    catch { return ''; }
  }
  return defaultUrlTransform(url);
}

/** Converts a clicked local link to a filesystem path and optional 1-based editor line; never navigates to file://. */
export function parseLocalFileLink(reference: string): {path:string;line:number|null} {
  let value=reference.trim();
  let fragmentLine:number|null=null;
  if(/^file:\/\//i.test(value)) {
    const url=new URL(value);
    if(url.hostname && url.hostname!=='localhost')throw new Error('Remote file hosts are not local preview links.');
    const match=url.hash.match(/^#L(\d+)(?:C\d+)?$/i);
    fragmentLine=match?Number(match[1]):null;
    value=url.pathname;
  }
  try {value=decodeURIComponent(value);}catch { /* A literal percent sign remains part of a valid filename. */ }
  value=value.replace(/\\/g,'/').replace(/^\/([a-z]:\/)/i,'$1');
  const suffix=value.match(/:(\d+)(?::\d+)?$/);
  return {path:suffix?value.slice(0,-suffix[0].length):value,line:suffix?Number(suffix[1]):fragmentLine};
}

/**
 * True when the basename abbreviates part of a filename with an ellipsis
 * (`02-left-…-clutter10.mp4`, `run...final.log`). Leading `./` and `../`
 * segments are directories, never abbreviations; such names resolve on the server.
 */
export function isAbbreviatedFilePath(path:string): boolean {
  const basename=path.replace(/\\/g,'/').split('/').pop() ?? '';
  if(/^\.+$/.test(basename))return false;
  const parts=basename.split(/…|\.{3,}/g);
  return parts.length>1 && parts.join('').length>=3;
}

/** Link components use this on raw references; remote or malformed file URLs are never abbreviations. */
export function isAbbreviatedFileReference(reference:string): boolean {
  try {return isAbbreviatedFilePath(parseLocalFileLink(reference).path);} catch {return false;}
}
