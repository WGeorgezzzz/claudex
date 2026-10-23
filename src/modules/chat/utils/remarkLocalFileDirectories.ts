import type { Root, RootContent } from 'mdast';

import { parseLocalFileLink } from '@/modules/chat/utils/localFileLink';

function absoluteFileDirectory(reference: string): string | undefined {
  try {
    const {path}=parseLocalFileLink(reference);
    if (/^(?:[a-z]:\/|\/)/i.test(path)&&/\.[a-z0-9]+$/i.test(path)) return path.slice(0,path.lastIndexOf('/')+1);
  } catch { /* Remote file URLs do not supply local path context. */ }
}

function paragraphFileDirectories(node: RootContent): string[] {
  const result=new Set<string>();
  const visit=(child:RootContent)=>{
    const reference=child.type==='inlineCode'?child.value:child.type==='link'?child.url:undefined;
    const directory=reference?absoluteFileDirectory(reference):undefined;
    if(directory)result.add(directory);
    // An explicitly named directory (`D:\out\`) is context for abbreviated names beside it.
    const named=child.type==='inlineCode'?child.value.replace(/\\/g,'/'):'';
    if(/^(?:[a-z]:\/|\/)/i.test(named)&&named.endsWith('/'))result.add(named);
    if('children' in child)for(const nested of child.children)visit(nested);
  };
  visit(node);return [...result];
}

/** Markdown supplies explicit directory context to inline filename links without changing their labels. */
export function remarkLocalFileDirectories() {
  return (tree: Root) => {
    let base: string | undefined;
    const directories = new Set<string>();
    const fileDirectories = new Set<string>();
    const references: Array<{node:RootContent;nearby:string[]}> = [];
    const walk = (node: Root | RootContent, rowDirectory?: string, nearby:string[] = []) => {
      if (node.type === 'code') return;
      // A report and its abbreviated sibling in one paragraph/list item share
      // that explicit directory; unrelated list items must not override it.
      if (node.type === 'paragraph') nearby=paragraphFileDirectories(node);
      if (node.type === 'tableRow') {
        const first = node.children[0]?.children.find(child => child.type === 'inlineCode');
        if (first?.type === 'inlineCode' && /[\\/]$/.test(first.value)) {
          const dir = first.value.replace(/\\/g, '/');
          rowDirectory = /^(?:[a-z]:\/|\/)/i.test(dir) ? dir : base ? base + dir : undefined;
          if (rowDirectory) directories.add(rowDirectory);
        }
      }
      if (node.type === 'inlineCode') {
        const value = node.value.replace(/\\/g, '/');
        const parent=absoluteFileDirectory(value);
        if(parent)fileDirectories.add(parent);
        if (/^(?:[a-z]:\/|\/)/i.test(value) && value.endsWith('/')) {
          directories.add(value);
          base = value;
        } else if (!/^(?:[a-z]:\/|\/|file:)/i.test(value) && /\.[a-z0-9]+(?::\d+(?::\d+)?)?$/i.test(value)) {
          node.data ??= {};
          node.data.hProperties = { ...node.data.hProperties, ...(rowDirectory ? { 'data-local-reference': rowDirectory + value } : {}) };
          references.push({node,nearby});
        }
      }
      if ('children' in node) for (const child of node.children) walk(child, rowDirectory,nearby);
    };
    walk(tree);
    for (const {node,nearby} of references) {
      node.data!.hProperties = { ...node.data!.hProperties, 'data-local-directories': JSON.stringify(nearby.length?nearby:[...new Set([...directories,...fileDirectories])]) };
    }
  };
}
