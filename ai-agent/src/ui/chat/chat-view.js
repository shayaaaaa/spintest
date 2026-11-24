import { html } from '../../../vendor/preact.mjs';
import { Icon } from '../icons.js';
export function ChatView() {
  return html`<div class="phead"><div class="phead-title"><${Icon} name="chat" />ChatView</div></div><div class="empty"><h3>ChatView</h3></div>`;
}
