import { useState } from 'react';

const STORAGE_KEY = 'task-group-preferences-v1';

/** Keeps explicit group choices independent across project, grouping and status views. */
export function useTaskGroupPreferences() {
  // Only explicit choices are saved; new groups retain their attention-based default.
  const [preferences, setPreferences] = useState<Record<string, Record<string, boolean>>>(() => {
    try {
      const value: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
      if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
      const valid: Record<string, Record<string, boolean>> = {};
      for (const [view, groups] of Object.entries(value)) {
        if (!groups || typeof groups !== 'object' || Array.isArray(groups)) continue;
        const choices: Record<string, boolean> = {};
        for (const [group, expanded] of Object.entries(groups)) {
          if (typeof expanded === 'boolean') choices[group] = expanded;
        }
        valid[view] = choices;
      }
      return valid;
    } catch { return {}; }
  });

  function update(view: string, groups: Record<string, boolean>) {
    setPreferences(previous => {
      const next = { ...previous, [view]: { ...previous[view], ...groups } };
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* Memory still works in restricted browsers. */ }
      return next;
    });
  }
  return { preferences, update };
}
