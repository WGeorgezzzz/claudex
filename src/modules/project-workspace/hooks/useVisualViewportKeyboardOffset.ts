import { useEffect } from 'react';

/** Keeps the fixed workspace shell above the virtual keyboard in iOS Safari. */
export function useVisualViewportKeyboardOffset() {
  useEffect(() => {
    const visualViewport = window.visualViewport;
    if (!visualViewport) {
      return undefined;
    }

    const updateKeyboardHeight = () => {
      const keyboardHeight = Math.max(0, window.innerHeight - visualViewport.height - visualViewport.offsetTop);
      document.documentElement.style.setProperty('--keyboard-height', `${keyboardHeight}px`);
      document.documentElement.style.setProperty('--visual-viewport-height', `${visualViewport.height}px`);
      document.documentElement.style.setProperty('--visual-viewport-top', `${visualViewport.offsetTop}px`);
    };

    updateKeyboardHeight();
    visualViewport.addEventListener('resize', updateKeyboardHeight);
    visualViewport.addEventListener('scroll', updateKeyboardHeight);
    return () => {
      visualViewport.removeEventListener('resize', updateKeyboardHeight);
      visualViewport.removeEventListener('scroll', updateKeyboardHeight);
      for (const property of ['--keyboard-height', '--visual-viewport-height', '--visual-viewport-top']) {
        document.documentElement.style.removeProperty(property);
      }
    };
  }, []);
}
