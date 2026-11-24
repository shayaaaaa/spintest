// Shared input handling: /commands, !shell (direct), #memory, then the agent loop.
import { runSlash } from '../../agent/commands.js';
import { createShell } from '../../shell/host.js';
import * as vfs from '../../core/vfs.js';
import { toast } from '../kit.js';

export async function handleSubmit(session, text, attachments, ui) {
  if (text.startsWith('/') && !attachments.length) {
    const r = await runSlash(session, text, ui);
    if (r.send) return session.send(r.send);
    return;
  }
  if (text.startsWith('!') && !attachments.length) {
    const cmd = text.slice(1).trim();
    if (!cmd) return;
    const sh = session.shell ||= createShell({ cwd: session.cwd, session });
    const r = await sh.run(cmd, {});
    const out = (r.stdout + r.stderr).replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
    if (sh.cwd !== session.cwd) session.setCwd(sh.cwd);
    session.push({ role: 'user', content: `<bash-input>${cmd}</bash-input>\n<bash-stdout>${out.slice(0, 20000)}</bash-stdout>${r.code ? `\n<bash-exit>${r.code}</bash-exit>` : ''}` });
    session.save();
    return;
  }
  if (text.startsWith('#') && !attachments.length) {
    const note = text.slice(1).trim();
    if (!note) return;
    const cur = await vfs.readText('/memory/MEMORY.md').catch(() => '# Memory\n');
    await vfs.write('/memory/MEMORY.md', cur.replace(/\s*$/, '') + `\n- ${note}\n`);
    toast('Saved to memory (MEMORY.md)', 'ok');
    session.notice(`Remembered: ${note}`);
    return;
  }
  return session.send(text, { attachments });
}
