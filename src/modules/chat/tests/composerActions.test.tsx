import assert from 'node:assert/strict';

import { fireEvent, render, screen } from '@testing-library/react';
import { createPortal } from 'react-dom';
import { useState } from 'react';
import { test } from 'vitest';

import '@/modules/i18n';
import { ComposerActions } from '@/modules/chat/composer/ComposerActions';

function DialogAction(){
  // Simulates secondary actions that own a dialog outside the disclosure.
  const [open,setOpen]=useState(false);
  return <><button onClick={()=>setOpen(true)}>Open action</button>{open&&createPortal(<div role="dialog"><input aria-label="Action draft"/></div>,document.body)}</>;
}

test('closing the action disclosure does not unmount a dialog or lose its draft',()=>{
  const view=render(<ComposerActions><DialogAction/></ComposerActions>);
  const details=view.container.querySelector('details')!;details.open=true;
  fireEvent.click(screen.getByRole('button',{name:'Open action'}));
  fireEvent.change(screen.getByRole('textbox',{name:'Action draft'}),{target:{value:'retain'}});
  fireEvent.pointerDown(screen.getByRole('dialog'));
  assert.equal(details.open,false);
  assert.equal((screen.getByRole('textbox',{name:'Action draft'}) as HTMLInputElement).value,'retain');
});

test('Escape closes the disclosure and restores keyboard focus to the trigger',()=>{
  const view=render(<ComposerActions><button>Action</button></ComposerActions>);
  const details=view.container.querySelector('details')!;details.open=true;
  fireEvent.keyDown(screen.getByRole('button',{name:'Action'}),{key:'Escape'});
  assert.equal(details.open,false);assert.equal(document.activeElement,details.querySelector('summary'));
});
