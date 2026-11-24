// App-wide event bus for cross-tab actions (open a file in the editor, start a chat, etc.).
import { Emitter } from './util.js';
export const bus = new Emitter();
