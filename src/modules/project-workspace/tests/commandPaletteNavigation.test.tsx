import assert from 'node:assert/strict';

import { render, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { test, vi } from 'vitest';

import ProjectCommandPalette from '@/modules/project-workspace/ProjectCommandPalette';
import type { PaletteSessionEntry } from '@/shared/types';

const state = vi.hoisted(() => ({handleSessionSelect: vi.fn(), handleNewSession: vi.fn(), openSettings: vi.fn(), setActiveTab: vi.fn(),
  selectedProject: {projectId: 'one'}, projects: [{projectId: 'two', sessions: [{id: 'older', model: 'saved-model', effort: 'high', __provider: 'claude', summary: 'Before'}]}]}));
vi.mock('@/modules/project-workspace/context/ProjectsStateContext', () => ({useProjectCommandState: () => state}));
vi.mock('@/modules/command-palette', () => ({CommandPalette: ({onSelectSession}: {onSelectSession: (entry: PaletteSessionEntry) => void}) =>
  <button onClick={() => onSelectSession({id: 'older', projectId: 'two', label: 'New title', provider: 'claude', snippet: 'matched text', timestamp: '2026-10-22T01:00:00Z'})}>Pick</button>}));

test('a cross-project search pick retains known model metadata and its exact message jump', () => {
  render(<MemoryRouter><ProjectCommandPalette/></MemoryRouter>);
  fireEvent.click(document.querySelector('button')!);
  const session = state.handleSessionSelect.mock.calls[0][0];
  assert.equal(session.__projectId, 'two');
  assert.equal(session.model, 'saved-model');
  assert.equal(session.effort, 'high');
  assert.equal(session.__searchTargetSnippet, 'matched text');
  assert.equal(session.__searchTargetTimestamp, '2026-10-22T01:00:00Z');
});
