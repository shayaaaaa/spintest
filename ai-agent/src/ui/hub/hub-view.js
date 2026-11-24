import { html } from '../../../vendor/preact.mjs';
import { Icon } from '../icons.js';
export function HubView() {
  return html`<div class="phead"><div class="phead-title"><${Icon} name="folder" />HubView</div></div><div class="empty"><h3>HubView</h3></div>`;
}
