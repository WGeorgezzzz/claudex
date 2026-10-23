import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ToolRenderer } from '@/modules/chat/tools/ToolRenderer';

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
