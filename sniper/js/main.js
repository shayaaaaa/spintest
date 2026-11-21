// Entry point: boots audio, UI and the game loop, and registers the offline cache.
import { Game } from './game.js';
import { UI } from './ui.js';
import { Sound } from './audio.js';
import { save } from './save.js';

const loading = document.getElementById('loading');

function boot() {
  const audio = new Sound();
  audio.enabled = save.settings.sound;
  const ui = new UI();
  const game = new Game(document.getElementById('view'), ui, audio);
  ui.bind(game, audio);
  ui.show('menu');
  window.addEventListener('resize', () => { game.resize(); ui.resize(); });
  window.__game = game;

  let last = performance.now();
  let first = true;
  function frame(now) {
    const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
    last = now;
    game.update(dt);
    ui.frame(dt);
    game.render();
    if (first) { first = false; loading.hidden = true; }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

try {
  boot();
} catch (err) {
  console.error(err);
  loading.textContent = 'This device could not start the game (WebGL is unavailable).';
  loading.style.fontSize = '18px';
  loading.style.padding = '24px';
  loading.style.textAlign = 'center';
}

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch(() => { /* offline cache unavailable here */ });
}
