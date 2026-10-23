import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test } from 'vitest';

import { ActionMenu } from '@/shared/ui/ActionMenu';

test('a scrolling action menu stays open and keeps every action reachable', () => {
  render(<ActionMenu label="Actions" items={Array.from({length: 20}, (_, i) => ({key:String(i),label:`Action ${i}`,onSelect:()=>{}}))}/>);
  fireEvent.click(screen.getByRole('button',{name:'Actions'}));
  const menu=screen.getByRole('menu',{name:'Actions'});
  fireEvent.scroll(menu);
  expect(screen.getByRole('menu',{name:'Actions'})).toBe(menu);
  fireEvent.click(screen.getByRole('menuitem',{name:'Action 19'}));
  expect(screen.queryByRole('menu')).toBeNull();
});
