import assert from 'node:assert/strict';

import { render, screen, waitFor } from '@testing-library/react';
import { test, vi } from 'vitest';

import type { Project } from '@/shared/types';

/**
 * Regression guard for the wiring, not the maths: a directory reference clicked
 * in the chat reaches the tree as the model wrote it — relative to the project
 * root — while every node here is keyed by its absolute path. Rendering the
 * real tree is what proves the two ends still meet.
 */

const ROOT = '/home/odoo/workspace/personal';

const tree = [
  {
    type: 'directory',
    name: 'decisions',
    path: `${ROOT}/decisions`,
    children: [{ type: 'file', name: '0001-first.md', path: `${ROOT}/decisions/0001-first.md` }],
  },
];

vi.mock('@/shared/api', () => ({
  api: {
    getFileChildren: async (_id:string,directory:string) => ({ ok: true, json: async () => directory === `${ROOT}/lazy` ? [{type:'directory',name:'nested',path:`${ROOT}/lazy/nested`}] : directory === `${ROOT}/lazy/nested` ? [{type:'file',name:'deep.md',path:`${ROOT}/lazy/nested/deep.md`}] : [...tree,{type:'directory',name:'lazy',path:`${ROOT}/lazy`}] }),
  },
}));

const { default: FileTree } = await import('@/modules/file-tree/FileTree');

const project: Project = { projectId: 'p1', displayName: 'personal', fullPath: ROOT, path: ROOT };

test('a relative directory reference expands that folder in the tree', async () => {
  render(<FileTree selectedProject={project} revealDirectory={{ path: 'decisions/' }} />);

  await waitFor(() => assert.ok(screen.getByText('decisions')));
  // Visible only because the folder was expanded for us.
  await waitFor(() => assert.ok(screen.getByText('0001-first.md')));
});

test('a folder nobody asked for stays closed', async () => {
  render(<FileTree selectedProject={project} revealDirectory={null} />);

  await waitFor(() => assert.ok(screen.getByText('decisions')));
  assert.equal(screen.queryByText('0001-first.md'), null);
});

test('a nested reveal loads each missing ancestor before opening the target',async()=>{
  render(<FileTree selectedProject={project} revealDirectory={{path:'lazy/nested/'}}/>);
  await waitFor(()=>assert.ok(screen.getByText('deep.md')));
});
