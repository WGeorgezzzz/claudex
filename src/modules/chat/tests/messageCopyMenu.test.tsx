import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test } from 'vitest';

import '@/modules/i18n';
import MessageCopyControl from '@/modules/chat/transcript/MessageCopyControl';

test('copy format menu survives scrolling, selects a format and closes with Escape',()=>{
  render(<MessageCopyControl messageType="assistant" content="**A reply**"/>);
  const trigger=screen.getByRole('button',{name:'Select copy format'});
  fireEvent.click(trigger);
  fireEvent.scroll(screen.getByRole('menu',{name:'Select copy format'}));
  fireEvent.click(screen.getByRole('button',{name:'Copy as text'}));
  expect(screen.queryByRole('menu')).toBeNull();
  expect(screen.getByText('TXT')).toBeTruthy();
  fireEvent.click(trigger);
  fireEvent.keyDown(window,{key:'Escape'});
  expect(screen.queryByRole('menu')).toBeNull();
  expect(document.activeElement).toBe(trigger);
});
