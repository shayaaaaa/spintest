// Phone actions: iOS Shortcuts, opening links/apps, clipboard, the in-app browser.
// iOS only lets a web app open other apps from a user tap, so these tools show a card with a button the user taps.

export const RunShortcut = {
  name: 'RunShortcut',
  description: 'Run one of the user\'s iOS Shortcuts by name (send messages, add reminders/calendar events, control Home devices, read Health data, etc.), optionally passing text input. The user taps to start it; the result comes back if the shortcut ends with "Copy to Clipboard".',
  input_schema: { type: 'object', properties: { name: { type: 'string', description: 'Exact shortcut name' }, input: { type: 'string' }, waitForResult: { type: 'boolean' } }, required: ['name'] },
  kind: 'exec',
  key: (i) => i.name,
  summary: (i) => i.name + (i.input ? ` ← "${i.input.slice(0, 40)}"` : ''),
  async run({ name, input = '', waitForResult = true }, ctx) {
    const res = await ctx.session.parentOrSelf().request({ type: 'shortcut', name, input, waitForResult });
    if (!res) return { content: 'The user did not run the shortcut.', isError: true };
    if (res.result != null) return { content: `Shortcut "${name}" finished. Result:\n${res.result}`, display: { kind: 'text', text: 'Shortcut finished' } };
    return { content: `Shortcut "${name}" was started.${waitForResult ? ' No result was returned.' : ''}`, display: { kind: 'text', text: 'Shortcut started' } };
  },
};

export const OpenURL = {
  name: 'OpenURL',
  description: 'Open a link or app URL for the user: web pages (Safari), tel:, sms:, mailto:, maps (https://maps.apple.com/?q=…), facetime:, or app deep links. The user taps to confirm.',
  input_schema: { type: 'object', properties: { url: { type: 'string' }, label: { type: 'string' } }, required: ['url'] },
  kind: 'exec',
  key: (i) => { try { return new URL(i.url).protocol; } catch { return i.url; } },
  summary: (i) => i.url,
  async run({ url, label }, ctx) {
    const ok = await ctx.session.parentOrSelf().request({ type: 'action', title: label || 'Open link', description: url, button: 'Open', action: () => window.open(url, '_blank') });
    return ok ? `Opened ${url}` : { content: 'The user did not open it.', isError: true };
  },
};

export const Clipboard = {
  name: 'Clipboard',
  description: 'Copy text to the clipboard (action "write"), or read what the user copied (action "read"). Both need one tap from the user.',
  input_schema: { type: 'object', properties: { action: { type: 'string', enum: ['read', 'write'] }, text: { type: 'string' } }, required: ['action'] },
  kind: 'other', readOnly: true,
  summary: (i) => i.action,
  async run({ action, text }, ctx) {
    const root = ctx.session.parentOrSelf();
    if (action === 'write') {
      const ok = await root.request({ type: 'action', title: 'Copy to clipboard', description: text.length > 200 ? text.slice(0, 200) + '…' : text, button: 'Copy', action: () => navigator.clipboard.writeText(text) });
      return ok ? 'Copied to the clipboard.' : { content: 'Not copied.', isError: true };
    }
    let got = null;
    const ok = await root.request({ type: 'action', title: 'Paste from clipboard', description: 'The agent wants to read your clipboard.', button: 'Paste', action: async () => { got = await navigator.clipboard.readText(); } });
    return ok && got != null ? `Clipboard contents:\n${got}` : { content: 'The clipboard was not shared.', isError: true };
  },
};

export const Browser = {
  name: 'Browser',
  description: 'Open a web page in the in-app browser panel so the user can see it (for reading page content yourself, use WebFetch). Many sites refuse to load inside apps; the panel then offers to open Safari.',
  input_schema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
  readOnly: true, kind: 'network',
  key: (i) => { try { return 'domain:' + new URL(i.url).hostname; } catch { return i.url; } },
  summary: (i) => i.url,
  async run({ url }, ctx) {
    const { bus } = await import('../../core/bus.js');
    bus.emit('browser-open', { url: /^https?:/.test(url) ? url : 'https://' + url });
    return `Opened ${url} in the browser panel. Use WebFetch to read its content.`;
  },
};

export const deviceTools = [RunShortcut, OpenURL, Clipboard, Browser];
