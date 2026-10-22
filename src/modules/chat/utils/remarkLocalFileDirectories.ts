import type { Root, RootContent } from 'mdast';

/** Markdown supplies explicit directory context to inline filename links without changing their labels. */
export function remarkLocalFileDirectories() {
  return (tree: Root) => {
    let base: string | undefined;
    const directories = new Set<string>();
    const references: RootContent[] = [];
    const walk = (node: Root | RootContent, rowDirectory?: string) => {
      if (node.type === 'code') return;
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
        if (/^(?:[a-z]:\/|\/)/i.test(value) && value.endsWith('/')) {
          directories.add(value);
          base = value;
        } else if (!/^(?:[a-z]:\/|\/|file:)/i.test(value) && /\.[a-z0-9]+(?::\d+(?::\d+)?)?$/i.test(value)) {
          node.data ??= {};
          node.data.hProperties = { ...node.data.hProperties, ...(rowDirectory ? { 'data-local-reference': rowDirectory + value } : {}) };
          references.push(node);
        }
      }
      if ('children' in node) for (const child of node.children) walk(child, rowDirectory);
    };
    walk(tree);
    for (const node of references) {
      node.data!.hProperties = { ...node.data!.hProperties, 'data-local-directories': JSON.stringify([...directories]) };
    }
  };
}
