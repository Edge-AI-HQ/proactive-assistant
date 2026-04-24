export type BrowserControlMode = 'ai' | 'user' | 'idle';

/**
 * Actions that change the remote page or the browser session itself.
 * Anything not listed here is treated as read-only (snapshot, list_tabs,
 * console, get_text, screenshot) and remains callable by the AI even
 * while the user has taken over — reading state concurrently is safe
 * and lets the AI keep its situational awareness without stepping on
 * the user.
 *
 * `wait` is intentionally included: during user takeover the AI should
 * not be parking a long page-state wait that could race with the user's
 * own navigation.
 */
const MUTATION_ACTIONS = new Set([
  'open',
  'navigate',
  'click',
  'type',
  'press_key',
  'select',
  'wait',
  'scroll',
  'scroll_to',
  'go_back',
  'go_forward',
  'reload',
  'upload_file',
  'set_viewport',
  'new_tab',
  'switch_tab',
  'close_tab',
  'handle_dialog',
  'download',
  'close',
]);

export function isBrowserMutationAction(action: string): boolean {
  return MUTATION_ACTIONS.has(action);
}

export function assertBrowserToolAllowed(
  session: { controlMode: BrowserControlMode },
  action: string,
): void {
  if (session.controlMode !== 'user') return;
  if (!isBrowserMutationAction(action)) return;
  throw new Error(
    'The user is currently controlling the browser. Wait until they return control to AI, then call "snapshot" before continuing.',
  );
}
