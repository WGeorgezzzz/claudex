const TOGGLE_EVENT='claudex:quick-settings-toggle';

/** Sidebar uses this action to open the shared display/command drawer without a floating screen handle. */
export function toggleQuickSettingsPanel() { window.dispatchEvent(new Event(TOGGLE_EVENT)); }

/** QuickSettingsPanelView owns the subscription and its existing persisted panel state. */
export function subscribeQuickSettingsToggle(listener:()=>void) {
  window.addEventListener(TOGGLE_EVENT,listener);
  return()=>window.removeEventListener(TOGGLE_EVENT,listener);
}
