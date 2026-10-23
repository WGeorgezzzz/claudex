import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ToolRenderer } from '@/modules/chat/tools/ToolRenderer';
import { OneLineDisplay } from '@/modules/chat/tools/OneLineDisplay';
import { SubagentTimeline } from '@/modules/chat/tools/SubagentTimeline';

describe.each(['Bash', 'PowerShell'])('%s command collapse', (toolName) => {
  it.each([false, true])('keeps output collapsed, including errors (%s)', (isError) => {
    const { container, getByRole } = render(
      <ToolRenderer toolName={toolName} mode="input"
        toolInput={{ command: 'echo first\necho second' }}
        toolResult={{ content: 'command output', isError }} />,
    );
    const toggle = getByRole('button', { expanded: false });
    expect(container.querySelector('pre')).toBeNull();
    expect(container.querySelector('.bg-gray-900')).toBeNull();
    fireEvent.click(toggle);
    expect(container.querySelector('pre')?.textContent).toBe('command output');
    expect(container.querySelector('.bg-gray-900, .bg-black, .text-green-400')).toBeNull();
    fireEvent.click(toggle);
    expect(container.querySelector('pre')).toBeNull();
  });

  it('truncates a running multiline command instead of showing a terminal block', () => {
    const { container } = render(
      <ToolRenderer toolName={toolName} mode="input"
        toolInput={{ command: 'echo first\necho second' }} />,
    );
    expect(container.querySelector('.truncate')?.textContent).toBe('echo first\necho second');
    expect(container.querySelector('.bg-gray-900')).toBeNull();
  });
});

it('legacy terminal configuration also uses a collapsed neutral row', () => {
  const { container, getByRole } = render(<OneLineDisplay toolName="PowerShell" style="terminal"
    value={'echo first\necho second'} wrapText toolResult={{ content: 'legacy output' }} />);
  expect(container.querySelector('pre')).toBeNull();
  fireEvent.click(getByRole('button', { expanded: false }));
  expect(container.querySelector('pre')?.textContent).toBe('legacy output');
  expect(container.querySelector('.bg-gray-900, .bg-black, .text-green-400')).toBeNull();
});

it('nested Claude command history stays compact and neutral too', () => {
  const { container, getByRole } = render(<SubagentTimeline createDiff={() => []} activity={[
    { kind: 'tool', toolId: 'nested', toolName: 'PowerShell', toolInput: { command: 'echo nested' }, toolResult: { content: 'nested output', isError: false } },
  ]} />);
  expect(container.querySelector('pre')).toBeNull();
  fireEvent.click(getByRole('button', { expanded: false }));
  expect(container.querySelector('pre')?.textContent).toBe('nested output');
  expect(container.querySelector('.bg-gray-900, .bg-black, .text-green-400')).toBeNull();
});
