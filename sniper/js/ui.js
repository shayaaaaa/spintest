// Menus, HUD, scope overlay, radar and input wiring.
import { WEAPONS, CLASSES, UPGRADES, ITEMS, WALL_LEVELS, MAPS, LEVELS, ZOMBIES, weaponStats, weaponById, upgradeCost, upgradeInfo, levelObjective } from './data.js';
import { save, persist, resetSave, upgOf } from './save.js';

const $ = id => document.getElementById(id);
const fmt = n => '$' + Math.round(n).toLocaleString('en-US');
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

const STAR = on => `<svg viewBox="0 0 24 24" class="${on ? 'on' : ''}"><path d="M12 2.5l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 17.4l-5.9 3.1 1.2-6.5L2.5 9.4l6.6-.9z" fill="${on ? '#f0b13a' : 'rgba(255,255,255,.14)'}" stroke="${on ? '#ffe0a0' : 'none'}" stroke-width=".8"/></svg>`;
const ICON = {
  defend: '<svg class="ty" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7z"/></svg>',
  rescue: '<svg class="ty" viewBox="0 0 24 24" fill="none" stroke="#7bd66a" stroke-width="2"><circle cx="12" cy="6" r="3"/><path d="M6 21l2-8h8l2 8M12 13v8"/></svg>',
  boss: '<svg class="ty" viewBox="0 0 24 24" fill="none" stroke="#ff6a5a" stroke-width="2"><path d="M5 11a7 7 0 1 1 14 0c0 3-2 4-2 6H7c0-2-2-3-2-6z"/><circle cx="9.5" cy="11" r="1.5" fill="#ff6a5a"/><circle cx="14.5" cy="11" r="1.5" fill="#ff6a5a"/><path d="M9 21v-4M12 21v-4M15 21v-4"/></svg>',
  lock: '<svg class="ty" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>',
};
const TYPE_NAME = { defend: 'Defend', rescue: 'Rescue', boss: 'Boss' };
// Weapon class silhouettes for the HUD weapon bar and armory tabs.
const WICON = {
  sniper: '<svg viewBox="0 0 48 24" fill="currentColor"><path d="M2 12.5h27l2-1.5h15v2.5H33l-2 1.5h-9l-2.5 5h-4l1.5-5H2z"/><rect x="13" y="7.5" width="13" height="3" rx="1.5"/><rect x="17" y="10" width="2" height="2"/></svg>',
  auto: '<svg viewBox="0 0 48 24" fill="currentColor"><path d="M4 11h26l2-1.5h11v2.5H32v2.5h-6l-1 2.5 1.5 4h-4l-1.5-4 .6-2.5H18l-2 4h-4l1.6-4H4z"/><rect x="17" y="7" width="7" height="3" rx="1"/></svg>',
  pistol: '<svg viewBox="0 0 48 24" fill="currentColor"><path d="M12 7h24v5.5H25l-2.5 9h-6l2.4-9H12z"/><rect x="20" y="13" width="4" height="2"/></svg>',
  rocket: '<svg viewBox="0 0 48 24" fill="currentColor"><path d="M3 9.5h33v5H3z"/><path d="M36 8.5l9 3.5-9 3.5z"/><rect x="14" y="14.5" width="3.5" height="6" rx="1"/><rect x="6" y="6" width="6" height="3.5"/></svg>',
};

export class UI {
  constructor() {
    this.screen = undefined;
    this.backTo = 'menu';
    this.selLevel = Math.min(save.unlocked, LEVELS.length - 1);
    this.selMap = LEVELS[this.selLevel].map;
    this.survMap = 0;
    this.shopTab = 'rifle';
    this.shopCls = 'sniper';
    this.shopRifle = save.loadout.sniper;
    this.portraitOk = false;
    this.cache = {};
    this.frameN = 0;
    this.range = null;
    this.isTouch = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
    this.scopeCv = $('scope');
    this.sctx = this.scopeCv.getContext('2d');
    this.radar = $('radar');
    this.rctx = this.radar.getContext('2d');
  }

  bind(game, audio) {
    this.g = game; this.audio = audio;
    const unlock = () => audio.unlock();
    for (const ev of ['pointerdown', 'touchend', 'click']) window.addEventListener(ev, unlock, { capture: true });
    window.addEventListener('keydown', unlock, { capture: true });

    // navigation buttons
    document.addEventListener('click', e => {
      const b = e.target.closest('[data-go]');
      if (!b) return;
      audio.ui();
      const to = b.dataset.go;
      if (to === 'back') return this.show(this.backTo);
      if (to === 'armory' || to === 'settings') this.backTo = this.screen === 'result' ? 'campaign' : (this.screen || 'menu');
      if (this.screen === 'result') this.g.quitToMenu();
      this.show(to);
    });

    this.bindControls();
    this.bindMenus();
    this.resize();
    window.addEventListener('orientationchange', () => setTimeout(() => this.checkOrientation(), 300));
    document.addEventListener('visibilitychange', () => { if (document.hidden && this.g.state === 'playing') this.pause(); });
    document.addEventListener('gesturestart', e => e.preventDefault());
    document.addEventListener('dblclick', e => e.preventDefault());
  }

  // ---------------------------------------------------------- controls
  bindControls() {
    const g = this.g;
    const touch = $('touch');
    let lookId = null, lx = 0, ly = 0;
    touch.addEventListener('contextmenu', e => e.preventDefault());
    touch.addEventListener('pointerdown', e => {
      if (e.pointerType === 'mouse' && e.button === 2) { g.toggleScope(); return; }
      if (lookId !== null) return;
      lookId = e.pointerId; lx = e.clientX; ly = e.clientY;
      try { touch.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    });
    touch.addEventListener('pointermove', e => {
      if (e.pointerId !== lookId) return;
      g.look(e.clientX - lx, e.clientY - ly);
      lx = e.clientX; ly = e.clientY;
    });
    const endLook = e => { if (e.pointerId === lookId) lookId = null; };
    touch.addEventListener('pointerup', endLook);
    touch.addEventListener('pointercancel', endLook);
    touch.addEventListener('wheel', e => { if (g.scoped) g.setZoom(g.zoomT - e.deltaY * 0.0012); e.preventDefault(); }, { passive: false });

    const fire = $('btnFire');
    let fireId = null, fx = 0, fy = 0;
    this.fireHeld = false;
    fire.addEventListener('pointerdown', e => {
      e.preventDefault();
      g.fire();
      fireId = e.pointerId; fx = e.clientX; fy = e.clientY;
      this.fireHeld = true;
      fire.classList.add('pressed');
      try { fire.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    });
    fire.addEventListener('pointermove', e => {
      if (e.pointerId !== fireId) return;
      g.look(e.clientX - fx, e.clientY - fy);
      fx = e.clientX; fy = e.clientY;
    });
    const endFire = e => { if (e.pointerId === fireId) { fireId = null; this.fireHeld = false; fire.classList.remove('pressed'); } };
    fire.addEventListener('pointerup', endFire);
    fire.addEventListener('pointercancel', endFire);

    $('btnScope').addEventListener('pointerdown', e => { e.preventDefault(); g.toggleScope(); });
    $('wbar').addEventListener('pointerdown', e => {
      const b = e.target.closest('.wslot');
      if (!b) return;
      e.preventDefault();
      g.switchWeapon(b.dataset.cls);
    });
    $('btnReload').addEventListener('pointerdown', e => { e.preventDefault(); g.startReload(); });
    $('btnPause').addEventListener('click', () => this.pause());
    for (const b of document.querySelectorAll('.item')) {
      b.addEventListener('pointerdown', e => { e.preventDefault(); g.useItem(b.dataset.item); });
    }
    const track = $('zoomTrack');
    let zoomId = null;
    const setZ = e => {
      const r = track.getBoundingClientRect();
      g.setZoom(1 - (e.clientY - r.top - 16) / (r.height - 32));
    };
    track.addEventListener('pointerdown', e => { e.preventDefault(); zoomId = e.pointerId; setZ(e); try { track.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ } });
    track.addEventListener('pointermove', e => { if (e.pointerId === zoomId) setZ(e); });
    track.addEventListener('pointerup', e => { if (e.pointerId === zoomId) zoomId = null; });
    track.addEventListener('pointercancel', () => { zoomId = null; });

    window.addEventListener('keydown', e => {
      if (e.repeat) return;
      const k = e.key.toLowerCase();
      if (g.state === 'playing' && this.screen === null) {
        if (k === ' ' || k === 'f') { g.fire(); e.preventDefault(); }
        else if (k === 'e' || k === 'q' || k === 'shift') g.toggleScope();
        else if (k === 'r') g.startReload();
        else if (k >= '1' && k <= '4') g.switchWeapon(CLASSES[+k - 1].key);
        else if (k === 'z') g.useItem('focus');
        else if (k === 'x') g.useItem('strike');
        else if (k === 'c') g.useItem('repair');
        else if (k === 'escape' || k === 'p') this.pause();
      } else if (this.screen === 'pause' && (k === 'escape' || k === 'p')) this.resume();
    });
    this.keys = new Set();
    window.addEventListener('keydown', e => this.keys.add(e.key));
    window.addEventListener('keyup', e => this.keys.delete(e.key));
    window.addEventListener('blur', () => this.keys.clear());
  }

  pause() {
    if (this.g.state !== 'playing') return;
    this.g.state = 'paused';
    this.syncSettings();
    this.show('pause');
  }

  resume() {
    if (this.g.state !== 'paused') return;
    this.g.state = this.g.kc ? 'killcam' : 'playing';
    this.show(null);
  }

  // ---------------------------------------------------------- menus
  bindMenus() {
    const g = this.g;
    $('resumeBtn').addEventListener('click', () => { this.audio.ui(); this.resume(); });
    $('restartBtn').addEventListener('click', () => { this.audio.ui(); this.restart(); });
    $('quitBtn').addEventListener('click', () => { this.audio.ui(); g.quitToMenu(); this.show('menu'); });
    $('portraitBtn').addEventListener('click', () => { this.portraitOk = true; this.checkOrientation(); });

    for (const id of ['sens', 'sens2']) {
      $(id).addEventListener('input', e => {
        save.settings.sens = +e.target.value; persist(); this.syncSettings();
      });
    }
    const seg = (id, apply) => {
      $(id).addEventListener('click', e => {
        const b = e.target.closest('button'); if (!b) return;
        this.audio.ui(); apply(b.dataset.v); persist(); this.syncSettings();
      });
    };
    seg('invSeg', v => { save.settings.invertY = v === '1'; });
    seg('sndSeg', v => { save.settings.sound = v === '1'; this.audio.setEnabled(save.settings.sound); });
    seg('kcSeg', v => { save.settings.killcam = v === '1'; });
    seg('qSeg', v => { g.setQuality(v); });
    let resetArmed = 0;
    $('resetBtn').addEventListener('click', () => {
      const b = $('resetBtn');
      if (Date.now() - resetArmed > 3000) {
        resetArmed = Date.now(); b.textContent = 'Tap again to erase';
        setTimeout(() => { b.textContent = 'Reset'; }, 3000);
        return;
      }
      resetArmed = 0; b.textContent = 'Erased';
      resetSave();
      g.equip('ranger');
      this.selLevel = 0; this.selMap = 0; this.shopRifle = 'ranger';
      this.updateCash();
      setTimeout(() => { b.textContent = 'Reset'; }, 1500);
    });

    for (const t of document.querySelectorAll('[data-shop]')) {
      t.addEventListener('click', () => { this.audio.ui(); this.shopTab = t.dataset.shop; this.renderArmory(); });
    }
  }

  syncSettings() {
    const s = save.settings;
    $('sens').value = s.sens; $('sens2').value = s.sens;
    $('sensVal').textContent = s.sens.toFixed(1) + '×';
    $('sensVal2').textContent = s.sens.toFixed(1) + '×';
    const on = (id, v) => { for (const b of $(id).querySelectorAll('button')) b.classList.toggle('on', b.dataset.v === v); };
    on('invSeg', s.invertY ? '1' : '0');
    on('sndSeg', s.sound ? '1' : '0');
    on('kcSeg', s.killcam ? '1' : '0');
    on('qSeg', s.quality);
  }

  show(name) {
    if (this.screen === 'armory' && name !== 'armory') { this.g.gun.showcase = false; this.g.refreshLoadout(); }
    for (const id of ['menu', 'campaign', 'survival', 'armory', 'settings', 'pause', 'result']) $(id).hidden = id !== name;
    this.screen = name;
    $('hud').hidden = name !== null;
    if (name === 'menu') this.renderMenu();
    if (name === 'campaign') this.renderCampaign();
    if (name === 'survival') this.renderSurvival();
    if (name === 'armory') { this.shopRifle = save.loadout[this.shopCls] || WEAPONS.find(w => w.cls === this.shopCls).id; this.renderArmory(); this.g.gun.showcase = true; }
    if (name === 'settings') this.syncSettings();
    if (name === null) { this.cache = {}; this.feedClear(); }
    this.updateCash();
    this.checkOrientation();
  }

  updateCash() { for (const el of document.querySelectorAll('[data-cash]')) el.textContent = fmt(save.cash); }

  renderMenu() {
    const s = save.stats;
    const acc = s.shots ? Math.round(s.hits / s.shots * 100) + '%' : '—';
    const done = save.stars.filter(x => x > 0).length;
    $('menuStats').innerHTML = `<span>Missions <b>${done}/${LEVELS.length}</b></span><span>Kills <b>${s.kills.toLocaleString('en-US')}</b></span><span>Headshots <b>${s.heads.toLocaleString('en-US')}</b></span><span>Accuracy <b>${acc}</b></span>`;
  }

  renderCampaign() {
    const tabs = $('mapTabs');
    tabs.innerHTML = '';
    MAPS.forEach((m, i) => {
      const open = save.unlocked >= i * 8;
      const stars = LEVELS.filter(L => L.map === i).reduce((a, L) => a + (save.stars[L.i] || 0), 0);
      const b = document.createElement('button');
      b.className = 'tab' + (i === this.selMap ? ' on' : '');
      b.disabled = !open;
      b.innerHTML = `${m.name}<small>${open ? stars + '/24 ★' : 'locked'}</small>`;
      b.addEventListener('click', () => {
        this.audio.ui(); this.selMap = i;
        const firstOpen = LEVELS.filter(L => L.map === i && L.i <= save.unlocked);
        this.selLevel = firstOpen.length ? firstOpen[firstOpen.length - 1].i : i * 8;
        if (this.g.mapIndex !== i && this.g.state === 'menu') this.g.loadMap(i);
        this.renderCampaign();
      });
      tabs.appendChild(b);
    });
    const grid = $('levelGrid');
    grid.innerHTML = '';
    for (const L of LEVELS.filter(x => x.map === this.selMap)) {
      const open = L.i <= save.unlocked;
      const b = document.createElement('button');
      b.className = 'lv' + (L.i === this.selLevel ? ' sel' : '') + (open ? '' : ' locked');
      const st = save.stars[L.i] || 0;
      b.innerHTML = `<span class="n">${String(L.i + 1).padStart(2, '0')}</span>${open ? ICON[L.type] : ICON.lock}<span class="st">${STAR(st >= 1)}${STAR(st >= 2)}${STAR(st >= 3)}</span>`;
      b.disabled = !open;
      b.addEventListener('click', () => { this.audio.ui(); this.selLevel = L.i; this.renderCampaign(); });
      grid.appendChild(b);
    }
    const L = LEVELS[this.selLevel];
    const chips = Object.entries(L.comp).map(([t, n]) => `<span class="chip"><b>${n}</b> ${ZOMBIES[t].name}</span>`).join('') +
      (L.boss ? `<span class="chip" style="border-color:#ff6a5a"><b>1</b> ${L.boss.name}</span>` : '') +
      (L.survivors ? `<span class="chip" style="border-color:#7bd66a"><b>${L.survivors}</b> Survivors</span>` : '');
    const st = save.stars[L.i] || 0;
    const reward = st > 0 ? Math.round(L.reward * 0.5) : L.reward;
    $('levelDetail').innerHTML = `
      <div class="lbl">Mission ${String(L.i + 1).padStart(2, '0')} · ${TYPE_NAME[L.type]}</div>
      <h2>${L.name}</h2>
      <p>${levelObjective(L)}</p>
      <div class="chips">${chips}</div>
      <div class="row kv"><span>Reward up to <b>${fmt(reward)}</b>${st > 0 ? ' (replay)' : ''}</span><span class="st" style="display:flex;gap:2px">${STAR(st >= 1)}${STAR(st >= 2)}${STAR(st >= 3)}</span></div>
      <div class="row kv"><span>Loadout <b>${this.loadoutText()}</b></span><button class="back" data-go="armory" style="height:34px;flex:none">ARMORY</button></div>
      <button class="btn primary" id="startBtn">Start mission</button>`;
    for (const s of $('levelDetail').querySelectorAll('.st svg')) { s.style.width = '18px'; s.style.height = '18px'; }
    $('startBtn').addEventListener('click', () => {
      this.audio.ui();
      this.g.startCampaign(this.selLevel);
      this.show(null);
    });
  }

  renderSurvival() {
    const tabs = $('survTabs');
    tabs.innerHTML = '';
    MAPS.forEach((m, i) => {
      const open = save.unlocked >= i * 8;
      const b = document.createElement('button');
      b.className = 'tab' + (i === this.survMap ? ' on' : '');
      b.disabled = !open;
      b.innerHTML = `${m.name}<small>${open ? 'best ' + (save.best[m.id] || 0) : 'locked'}</small>`;
      b.addEventListener('click', () => { this.audio.ui(); this.survMap = i; if (this.g.state === 'menu') this.g.loadMap(i); this.renderSurvival(); });
      tabs.appendChild(b);
    });
    const M = MAPS[this.survMap];
    $('survDetail').innerHTML = `
      <div class="lbl">Endless · ${M.sub}</div>
      <h2>${M.name}</h2>
      <p>Waves never stop. Each one adds more runners, brutes and soldiers.</p>
      <div class="row kv"><span>Best <b>${save.best[M.id] || 0} waves</b></span></div>
      <div class="row kv"><span>Loadout <b>${this.loadoutText()}</b></span><button class="back" data-go="armory" style="height:34px;flex:none">ARMORY</button></div>
      <button class="btn primary" id="survStart">Start survival</button>`;
    $('survStart').addEventListener('click', () => { this.audio.ui(); this.g.startSurvival(this.survMap); this.show(null); });
  }

  loadoutText() {
    return CLASSES.map(c => save.loadout[c.key] && save.owned[save.loadout[c.key]] ? weaponById(save.loadout[c.key]).name : null)
      .filter(Boolean).join(' · ');
  }

  statBars(st) {
    const bar = (name, f, v) => `<div class="stat"><span>${name}</span><span class="t"><i style="width:${Math.round(clamp(f, 0.04, 1) * 100)}%"></i></span><span class="v">${v}</span></div>`;
    const rate = Math.round(60 / st.bolt);
    const range = st.falloff ? st.falloff[1] : 0;
    const ctrl = st.spreadMax ? Math.round((1 - st.spreadMax / 0.05) * 100) : 0;
    const rows = {
      sniper: [['DAMAGE', st.dmg / 420, st.dmg], ['ZOOM', st.zoom / 12, st.zoom + '×'], ['FIRE RATE', (1 / st.bolt) / 3.2, rate + '/m'],
        ['MAGAZINE', st.mag / 16, st.mag], ['RELOAD', (3.4 - st.reload) / 2.2, st.reload.toFixed(1) + 's'],
        ['STABILITY', (1.4 - st.sway) / 1.1, Math.round((1.4 - st.sway) / 1.1 * 100)], ['PIERCE', st.pen / 3, st.pen]],
      auto: [['DAMAGE', st.dmg / 100, st.dmg], ['FIRE RATE', rate / 800, rate + '/m'], ['MAGAZINE', st.mag / 160, st.mag],
        ['RELOAD', (6 - st.reload) / 4.5, st.reload.toFixed(1) + 's'], ['RANGE', range / 130, range + ' m'],
        ['CONTROL', ctrl / 100, ctrl], ['ZOOM', st.zoom / 4, st.zoom + '×']],
      pistol: [['DAMAGE', st.dmg / 180, st.dmg], ['FIRE RATE', rate / 950, rate + '/m'], ['MAGAZINE', st.mag / 40, st.mag],
        ['RELOAD', (2.6 - st.reload) / 2, st.reload.toFixed(1) + 's'], ['RANGE', range / 100, range + ' m'], ['CONTROL', ctrl / 100, ctrl]],
      rocket: [['DAMAGE', st.dmg / 1100, st.dmg], ['BLAST', st.blast / 8, st.blast + ' m'], ['ROCKETS', st.mag / 6, st.mag],
        ['RELOAD', (10 - st.reload) / 8, st.reload.toFixed(1) + 's'], ['ZOOM', st.zoom / 4, st.zoom + '×']],
    }[st.cls];
    return rows.map(r => bar(...r)).join('');
  }

  renderArmory() {
    for (const t of document.querySelectorAll('[data-shop]')) t.classList.toggle('on', t.dataset.shop === this.shopTab);
    const cls = this.shopCls;
    const ctabs = $('clsTabs');
    ctabs.innerHTML = '';
    for (const c of CLASSES) {
      const b = document.createElement('button');
      b.className = 'tab cls' + (c.key === cls ? ' on' : '');
      b.innerHTML = `${WICON[c.key]}${{ sniper: 'Sniper', auto: 'Auto', pistol: 'Pistol', rocket: 'Rocket' }[c.key]}`;
      b.addEventListener('click', () => {
        this.audio.ui();
        this.shopCls = c.key;
        this.shopRifle = save.loadout[c.key] || WEAPONS.find(w => w.cls === c.key).id;
        this.shopTab = 'rifle';
        this.renderArmory();
      });
      ctabs.appendChild(b);
    }
    const id = this.shopRifle;
    const R = weaponById(id);
    const owned = !!save.owned[id];
    const st = weaponStats(id, owned ? upgOf(id) : {});
    if (this.g.gun.def?.id !== id) this.g.gun.setWeapon(st);
    $('rfName').textContent = R.name;
    $('rfDesc').textContent = R.desc;
    const list = $('rfList');
    list.innerHTML = '';
    for (const r of WEAPONS.filter(w => w.cls === cls)) {
      const b = document.createElement('button');
      const eq = save.loadout[cls] === r.id && !!save.owned[r.id], ow = !!save.owned[r.id];
      b.className = 'rf' + (r.id === id ? ' on' : '') + (ow ? ' owned' : '') + (eq ? ' eq' : '');
      b.innerHTML = `<i></i>${r.name}`;
      b.addEventListener('click', () => { this.audio.ui(); this.shopRifle = r.id; this.renderArmory(); });
      list.appendChild(b);
    }
    const body = $('shopBody');
    if (this.shopTab === 'rifle') {
      const C = CLASSES.find(c => c.key === cls);
      let html = `<p class="kv" style="margin:0 0 6px">${C.blurb}</p>` + this.statBars(st);
      if (!owned) {
        html += `<div class="row" style="margin-top:10px"><span class="kv">Price <b>${fmt(R.price)}</b></span><button class="btn primary" id="buyRifle" ${save.cash >= R.price ? '' : 'disabled'}>Buy</button></div>`;
        if (save.cash < R.price) html += `<p class="kv" style="margin:6px 0 0">You need ${fmt(R.price - save.cash)} more. Replay missions or try Survival to earn cash.</p>`;
      } else {
        const eq = save.loadout[cls] === id;
        html += `<div class="row" style="margin-top:10px"><span class="kv">${eq ? `Your ${C.one.toLowerCase()} for missions` : 'Owned'}</span><button class="btn ${eq ? '' : 'primary'}" id="equipRifle" ${eq ? 'disabled' : ''}>${eq ? 'Equipped' : 'Equip'}</button></div>`;
        html += `<div class="sectionT">UPGRADES</div>`;
        const u = upgOf(id);
        for (const U of UPGRADES) {
          const info = upgradeInfo(cls, U.key);
          const lvl = u[U.key] || 0;
          const cost = upgradeCost(id, U.key, lvl);
          const pips = Array.from({ length: info.max }, (_, i) => `<i class="${i < lvl ? 'f' : ''}"></i>`).join('');
          html += `<div class="up"><div><div class="nm">${info.name}</div><div class="ds">${info.info}</div><div class="pips">${pips}</div></div>
            ${cost === null ? '<span class="kv"><b>MAX</b></span>' : `<button class="btn ${save.cash >= cost ? 'primary' : ''}" data-up="${U.key}" ${save.cash >= cost ? '' : 'disabled'}>${fmt(cost)}</button>`}</div>`;
        }
      }
      body.innerHTML = html;
      $('buyRifle')?.addEventListener('click', () => {
        if (save.cash < R.price) return;
        save.cash -= R.price; save.owned[id] = true; upgOf(id);
        this.g.equip(id); persist(); this.audio.buy(); this.updateCash(); this.renderArmory();
      });
      $('equipRifle')?.addEventListener('click', () => { this.g.equip(id); this.audio.ui(); this.renderArmory(); });
      for (const b of body.querySelectorAll('[data-up]')) {
        b.addEventListener('click', () => {
          const key = b.dataset.up, u = upgOf(id), cost = upgradeCost(id, key, u[key] || 0);
          if (cost === null || save.cash < cost) return;
          save.cash -= cost; u[key] = (u[key] || 0) + 1;
          persist(); this.g.refreshLoadout(); this.audio.buy(); this.updateCash(); this.renderArmory();
        });
      }
    } else {
      let html = '<div class="sectionT" style="margin-top:0">FIELD SUPPLIES</div>';
      for (const it of ITEMS) {
        html += `<div class="up"><div><div class="nm">${it.name} <span class="kv">· owned <b>${save.items[it.key] || 0}</b></span></div><div class="ds">${it.desc}</div></div>
          <button class="btn ${save.cash >= it.price ? 'primary' : ''}" data-item-buy="${it.key}" ${save.cash >= it.price ? '' : 'disabled'}>${fmt(it.price)}</button></div>`;
      }
      const wl = save.wall, next = WALL_LEVELS[wl + 1];
      const pips = Array.from({ length: WALL_LEVELS.length - 1 }, (_, i) => `<i class="${i < wl ? 'f' : ''}"></i>`).join('');
      html += `<div class="sectionT">OUTPOST</div><div class="up"><div><div class="nm">Reinforce the wall</div><div class="ds">Wall strength ${WALL_LEVELS[wl].hp.toLocaleString('en-US')}${next ? ' → ' + next.hp.toLocaleString('en-US') : ''}</div><div class="pips">${pips}</div></div>
        ${next ? `<button class="btn ${save.cash >= next.cost ? 'primary' : ''}" id="wallBuy" ${save.cash >= next.cost ? '' : 'disabled'}>${fmt(next.cost)}</button>` : '<span class="kv"><b>MAX</b></span>'}</div>`;
      body.innerHTML = html;
      for (const b of body.querySelectorAll('[data-item-buy]')) {
        b.addEventListener('click', () => {
          const it = ITEMS.find(x => x.key === b.dataset.itemBuy);
          if (save.cash < it.price) return;
          save.cash -= it.price; save.items[it.key] = (save.items[it.key] || 0) + 1;
          persist(); this.audio.buy(); this.updateCash(); this.renderArmory();
        });
      }
      $('wallBuy')?.addEventListener('click', () => {
        const nx = WALL_LEVELS[save.wall + 1];
        if (!nx || save.cash < nx.cost) return;
        save.cash -= nx.cost; save.wall++;
        persist(); this.audio.buy(); this.updateCash(); this.renderArmory();
      });
    }
  }

  restart() {
    const g = this.g;
    if (g.mode === 'survival') g.startSurvival(g.level.map);
    else g.startCampaign(g.level.i);
    this.show(null);
  }

  showResult(r) {
    const card = $('resultCard');
    const L = r.level, st = r.stats;
    const acc = st.shots ? Math.round(st.hits / st.shots * 100) : 0;
    let title, sub;
    if (r.mode === 'survival') {
      title = 'OVERRUN';
      sub = `You held ${MAPS[L.map].name} for ${r.wave - 1} wave${r.wave - 1 === 1 ? '' : 's'}${r.best ? '. New best!' : '.'}`;
    } else if (r.win) { title = 'MISSION COMPLETE'; sub = `${String(L.i + 1).padStart(2, '0')} · ${L.name}`; }
    else { title = 'MISSION FAILED'; sub = r.reason || 'The outpost has fallen.'; }
    const fourth = r.mode === 'survival' ? `<div><b>${r.wave - 1}</b><span>WAVES</span></div>`
      : L.type === 'rescue' ? `<div><b>${st.saved}/${L.survivors}</b><span>SAVED</span></div>`
        : `<div><b>${Math.round(this.g.wallHp / this.g.wallMax * 100)}%</b><span>WALL</span></div>`;
    const hasNext = r.mode === 'campaign' && r.win && L.i + 1 < LEVELS.length;
    card.innerHTML = `
      <h2 class="${r.win ? 'win' : 'lose'}">${title}</h2>
      <p class="sub">${sub}</p>
      ${r.mode === 'campaign' && r.win ? `<div class="stars">${[1, 2, 3].map(i => STAR(r.stars >= i)).join('')}</div>` : ''}
      <div class="tally"><div><b>${st.kills}</b><span>KILLS</span></div><div><b>${st.heads}</b><span>HEADSHOTS</span></div><div><b>${acc}%</b><span>ACCURACY</span></div>${fourth}</div>
      <div class="payout">
        <div class="row"><span>Kills and bonuses</span><b>${fmt(st.earned)}</b></div>
        ${r.mode === 'campaign' ? `<div class="row"><span>Mission reward${r.win && !r.first ? ' (replay)' : ''}</span><b>${fmt(r.bonus)}</b></div>` : ''}
        <div class="row tot"><span>Total earned</span><b>${fmt(r.total)}</b></div>
      </div>
      <div class="actions">
        ${hasNext ? '<button class="btn primary" id="nextBtn">Next mission</button>' : ''}
        <button class="btn ${hasNext ? '' : 'primary'}" id="retryBtn">Retry</button>
        <button class="btn" data-go="armory">Armory</button>
        <button class="btn" data-go="menu">Menu</button>
      </div>`;
    card.querySelectorAll('.stars svg').forEach((s, i) => { s.style.animationDelay = (0.25 + i * 0.25) + 's'; });
    $('nextBtn')?.addEventListener('click', () => {
      this.audio.ui();
      this.selLevel = L.i + 1; this.selMap = LEVELS[L.i + 1].map;
      this.g.startCampaign(L.i + 1); this.show(null);
    });
    $('retryBtn').addEventListener('click', () => { this.audio.ui(); this.restart(); });
    if (r.mode === 'campaign') {
      this.selLevel = hasNext ? L.i + 1 : L.i;
      this.selMap = LEVELS[this.selLevel].map;
    }
    this.show('result');
  }

  // ---------------------------------------------------------- HUD effects (called by the game)
  feedClear() { $('feed').innerHTML = ''; }
  feed(text, kind) {
    const f = $('feed');
    const d = document.createElement('div');
    d.textContent = text;
    if (kind) d.className = kind;
    f.appendChild(d);
    while (f.children.length > 3) f.firstChild.remove();
    setTimeout(() => d.remove(), 2700);
  }
  bigText(text, kind) {
    const el = $('big');
    el.className = kind || '';
    el.textContent = text;
    void el.offsetWidth;
    el.classList.add('on');
  }
  banner(title, sub) {
    const el = $('banner');
    el.querySelector('h2').textContent = title;
    el.querySelector('p').textContent = sub || '';
    el.classList.remove('on');
    void el.offsetWidth;
    el.classList.add('on');
  }
  hitmarker(kill) {
    const el = $('hit');
    el.className = '';
    void el.offsetWidth;
    el.className = kill ? 'on kill' : 'on';
  }
  wallHit() {
    const now = performance.now();
    if (now - (this.lastWallHit || 0) < 250) return;
    this.lastWallHit = now;
    const v = $('vHit'), b = $('wallBar');
    v.classList.add('on');
    setTimeout(() => v.classList.remove('on'), 90);
    b.classList.remove('shake'); void b.offsetWidth; b.classList.add('shake');
  }
  scopeFlash() {
    const f = $('flash');
    f.classList.add('on');
    setTimeout(() => f.classList.remove('on'), 60);
  }
  focus(on) { document.body.classList.toggle('focus', on); }
  killcam(on) {
    document.body.classList.toggle('killcam', on);
    $('kcBars').hidden = !on;
    if (on) { this.scopeCv.hidden = true; } else if (this.g.scopeShown) this.scopeCv.hidden = false;
  }
  // Snipers look through the scope overlay; every other class aims down a red-dot sight.
  setScoped(on) {
    const sniper = !this.g || this.g.rifle.cls === 'sniper';
    const scope = on && sniper, sight = on && !sniper;
    document.body.classList.toggle('scoped', scope);
    document.body.classList.toggle('sighted', sight);
    document.body.classList.toggle('rsight', sight && this.g.rifle.cls === 'rocket');
    this.scopeCv.hidden = !scope;
    $('zoomBox').hidden = !scope;
  }

  // ---------------------------------------------------------- layout
  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.sdpr = dpr;
    this.scopeCv.width = Math.round(window.innerWidth * dpr);
    this.scopeCv.height = Math.round(window.innerHeight * dpr);
    this.checkOrientation();
  }

  checkOrientation() {
    const portrait = window.innerHeight > window.innerWidth * 1.05;
    const block = portrait && this.isTouch && !this.portraitOk;
    $('rotate').hidden = !block;
    if (block && this.g?.state === 'playing') this.pause();
  }

  // ---------------------------------------------------------- per frame
  frame(dt) {
    const g = this.g;
    this.frameN++;
    if (this.screen !== null) return;
    if (g.state !== 'playing' && g.state !== 'killcam' && g.state !== 'over') return;
    // keyboard aiming for desktop players
    if (this.keys.size && g.state === 'playing') {
      const s = 420 * dt;
      if (this.keys.has('ArrowLeft') || this.keys.has('a')) g.look(-s, 0);
      if (this.keys.has('ArrowRight') || this.keys.has('d')) g.look(s, 0);
      if (this.keys.has('ArrowUp') || this.keys.has('w')) g.look(0, -s);
      if (this.keys.has('ArrowDown') || this.keys.has('s')) g.look(0, s);
    }
    if (this.fireHeld && (g.rifle.semi || g.rifle.auto)) g.fire();
    const c = this.cache;
    const set = (id, v, prop = 'textContent') => { if (c[id] !== v) { c[id] = v; $(id)[prop] = v; } };
    set('cash', fmt(g.stats.earned));
    const wf = g.wallHp / g.wallMax;
    set('wallNum', String(Math.ceil(g.wallHp)));
    if (c.wf !== wf) { c.wf = wf; $('wallFill').style.transform = `scaleX(${wf})`; $('wallBar').classList.toggle('low', wf < 0.35); }
    const boss = g.boss && g.boss.alive ? g.boss : null;
    if (c.bossOn !== !!boss) { c.bossOn = !!boss; $('bossBar').hidden = !boss; }
    if (boss) {
      const bf = Math.max(0, boss.hp / boss.maxHp);
      if (c.bf !== bf) { c.bf = bf; $('bossFill').style.transform = `scaleX(${bf})`; }
      set('bossName', boss.name.toUpperCase());
      set('bossNum', Math.ceil(bf * 100) + '%');
    }
    set('objective', this.objectiveText());
    const r = g.rifle;
    const ammoKey = r.id + ':' + g.ammo + '/' + r.mag;
    if (c.ammo !== ammoKey) {
      c.ammo = ammoKey;
      $('ammoNum').innerHTML = `${g.ammo}<small>/${r.mag}</small>`;
      $('rounds').innerHTML = r.mag <= 12
        ? Array.from({ length: r.mag }, (_, i) => `<i class="${i < g.ammo ? '' : 'x'}"></i>`).join('')
        : `<span class="abar"><b style="width:${Math.round(g.ammo / r.mag * 100)}%"></b></span>`;
    }
    const reloading = g.reloading > 0;
    const hint = reloading ? (r.cls === 'rocket' ? 'LOADING ROCKET' : 'RELOADING') : r.name.toUpperCase();
    if (c.hint !== hint) { c.hint = hint; const h = $('reloadHint'); h.textContent = hint; h.classList.toggle('busy', reloading); }
    if (c.rel !== reloading) { c.rel = reloading; $('btnReload').classList.toggle('busy', reloading); }
    const p = g.switchT > 0 ? 1 - g.switchT / r.swap : reloading ? 1 - g.reloading / r.reload : g.chamber > 0 ? 1 - g.chamber / r.bolt : 1;
    const pr = Math.round(p * 50) / 50;
    if (c.p !== pr) { c.p = pr; $('btnFire').style.setProperty('--p', pr); }
    for (const b of document.querySelectorAll('.item')) {
      const k = b.dataset.item, n = save.items[k] || 0;
      const key = 'it' + k;
      const act = k === 'focus' && g.focusT > 0;
      const v = n + (act ? 'a' : '');
      if (c[key] !== v) { c[key] = v; b.querySelector('.cnt').textContent = n; b.classList.toggle('empty', n <= 0); b.classList.toggle('active', act); }
    }
    if (c.scoped !== g.scoped) { c.scoped = g.scoped; $('btnScope').classList.toggle('on', g.scoped); }
    this.updateWeaponBar();
    const gap = Math.round(6 + g.spreadPx());
    if (c.gap !== gap) { c.gap = gap; $('cross').style.setProperty('--g', gap + 'px'); }
    if (g.scopeShown && r.cls === 'sniper') {
      const zl = g.zoomLevel();
      const zk = Math.round(g.zoomT * 100);
      if (c.zk !== zk) { c.zk = zk; const th = $('zoomTrack').clientHeight || 150; $('zoomKnob').style.top = `${(1 - g.zoomT) * (th - 37) + 2}px`; }
      set('zoomLbl', zl.toFixed(1) + '×');
      if (this.frameN % 4 === 0) this.range = g.rangeAtCenter();
      this.drawScope(zl);
    }
    if (this.frameN % 2 === 0) this.drawRadar();
  }

  updateWeaponBar() {
    const g = this.g, c = this.cache, bar = $('wbar');
    const key = Object.values(g.slots).map(sl => sl.w.id).join();
    if (c.wbar !== key) {
      c.wbar = key;
      bar.innerHTML = Object.keys(g.slots).map(k => `<button class="wslot" data-cls="${k}" aria-label="${CLASSES.find(x => x.key === k).one}">${WICON[k]}<i class="rl"><b></b></i></button>`).join('');
      c.wslots = {};
    }
    for (const b of bar.children) {
      const sl = g.slots[b.dataset.cls];
      const st = (b.dataset.cls === g.cls ? 'on' : '') + (sl.reloading > 0 ? 'r' + Math.round((1 - sl.reloading / sl.w.reload) * 20) : sl.ammo === 0 ? 'e' : '');
      if (c.wslots[b.dataset.cls] === st) continue;
      c.wslots[b.dataset.cls] = st;
      b.classList.toggle('on', b.dataset.cls === g.cls);
      b.classList.toggle('empty', sl.ammo === 0 && sl.reloading <= 0);
      b.classList.toggle('loading', sl.reloading > 0);
      b.querySelector('.rl b').style.width = sl.reloading > 0 ? Math.round((1 - sl.reloading / sl.w.reload) * 100) + '%' : '0';
    }
  }

  objectiveText() {
    const g = this.g, L = g.level;
    if (!L) return '';
    if (g.mode === 'survival') return `WAVE ${g.wave} · ${g.remainingCount()} LEFT`;
    if (L.type === 'defend') return `INFECTED ${g.remainingCount()} · WAVE ${g.waveNum}/${L.waves}`;
    if (L.type === 'rescue') return `SAVED ${g.stats.saved}/${L.required} · LOST ${g.stats.lost}/${L.survivors - L.required}`;
    if (L.type === 'boss') return g.boss ? (g.boss.alive ? `KILL THE ${g.boss.name.toUpperCase()}` : 'BOSS DOWN') : `BOSS INBOUND · ${g.remainingCount()}`;
    return '';
  }

  drawScope(zoom) {
    const cv = this.scopeCv, x = this.sctx, w = cv.width, h = cv.height, d = this.sdpr;
    const g = this.g;
    x.clearRect(0, 0, w, h);
    const R = Math.min(w, h) * 0.48, cx = w / 2, cy = h / 2;
    x.fillStyle = '#040504';
    x.beginPath(); x.rect(0, 0, w, h); x.arc(cx, cy, R, 0, Math.PI * 2, true); x.fill('evenodd');
    const gr = x.createRadialGradient(cx, cy, R * 0.72, cx, cy, R);
    gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(0.8, 'rgba(0,0,0,0.25)'); gr.addColorStop(1, 'rgba(0,0,0,0.92)');
    x.fillStyle = gr; x.beginPath(); x.arc(cx, cy, R, 0, Math.PI * 2); x.fill();
    // duplex reticle
    x.strokeStyle = 'rgba(6,8,6,0.95)';
    x.lineWidth = 1.3 * d;
    x.beginPath();
    x.moveTo(cx - R, cy); x.lineTo(cx + R, cy);
    x.moveTo(cx, cy - R); x.lineTo(cx, cy + R);
    x.stroke();
    x.lineWidth = 5 * d;
    x.beginPath();
    x.moveTo(cx - R, cy); x.lineTo(cx - R * 0.42, cy);
    x.moveTo(cx + R * 0.42, cy); x.lineTo(cx + R, cy);
    x.moveTo(cx, cy + R * 0.42); x.lineTo(cx, cy + R);
    x.stroke();
    x.fillStyle = 'rgba(6,8,6,0.95)';
    for (let i = 1; i <= 5; i++) {
      const o = R * 0.07 * i;
      for (const [px, py] of [[cx + o, cy], [cx - o, cy], [cx, cy + o], [cx, cy - o]]) { x.beginPath(); x.arc(px, py, 1.8 * d, 0, Math.PI * 2); x.fill(); }
    }
    // stadia ticks for range estimation below center
    x.lineWidth = 1.2 * d;
    for (let i = 1; i <= 3; i++) { const yy = cy + R * 0.07 * i * 1.0; x.beginPath(); x.moveTo(cx - R * 0.03 * (4 - i), yy); x.lineTo(cx + R * 0.03 * (4 - i), yy); x.stroke(); }
    // illuminated centre dot
    x.fillStyle = 'rgba(255,70,40,0.95)';
    x.beginPath(); x.arc(cx, cy, 2.2 * d, 0, Math.PI * 2); x.fill();
    // readouts
    x.font = `${12 * d}px ui-monospace, Menlo, monospace`;
    x.fillStyle = 'rgba(255,190,70,0.92)';
    x.textAlign = 'left';
    x.fillText(this.range ? `${Math.round(this.range)} m` : '--- m', cx + R * 0.1, cy - R * 0.06);
    x.textAlign = 'right';
    x.fillText(zoom.toFixed(1) + '×', cx - R * 0.1, cy - R * 0.06);
    // reload / bolt progress ring
    const r = g.rifle;
    const busy = g.reloading > 0 ? 1 - g.reloading / r.reload : g.chamber > 0 ? 1 - g.chamber / r.bolt : 1;
    if (busy < 1) {
      x.strokeStyle = g.reloading > 0 ? 'rgba(255,190,70,0.85)' : 'rgba(255,255,255,0.5)';
      x.lineWidth = 2.5 * d;
      x.beginPath(); x.arc(cx, cy, R * 0.16, -Math.PI / 2, -Math.PI / 2 + busy * Math.PI * 2); x.stroke();
      if (g.reloading > 0) { x.textAlign = 'center'; x.fillText('RELOADING', cx, cy + R * 0.26); }
    }
  }

  drawRadar() {
    const c = this.radar, x = this.rctx, W = c.width, H = c.height, s = W / 132;
    const g = this.g;
    x.clearRect(0, 0, W, H);
    const cx = W / 2, cy = H - 5 * s, range = 118, sc = (H - 10 * s) / range;
    const A = 1.32;
    x.fillStyle = 'rgba(8,12,8,0.6)';
    x.strokeStyle = 'rgba(240,177,58,0.35)';
    x.lineWidth = s;
    x.beginPath(); x.moveTo(cx, cy); x.arc(cx, cy, range * sc, -Math.PI / 2 - A, -Math.PI / 2 + A); x.closePath(); x.fill(); x.stroke();
    x.strokeStyle = 'rgba(240,177,58,0.15)';
    for (const rr of [40, 80]) { x.beginPath(); x.arc(cx, cy, rr * sc, -Math.PI / 2 - A, -Math.PI / 2 + A); x.stroke(); }
    // view cone
    const vf = (g.camera.fov * Math.PI / 180) / 2;
    const hf = Math.atan(Math.tan(vf) * g.camera.aspect);
    x.fillStyle = 'rgba(240,177,58,0.14)';
    x.beginPath(); x.moveTo(cx, cy);
    for (const a of [g.yaw + hf, g.yaw - hf]) x.lineTo(cx - Math.sin(a) * range * sc, cy - Math.cos(a) * range * sc);
    x.closePath(); x.fill();
    // wall
    x.strokeStyle = 'rgba(214,170,100,0.95)'; x.lineWidth = 2 * s;
    x.beginPath(); x.moveTo(cx - 22 * sc, cy - 14 * sc); x.lineTo(cx + 22 * sc, cy - 14 * sc); x.stroke();
    const blink = (this.frameN >> 3) % 2;
    for (const z of g.zombies) {
      if (!z.alive) continue;
      const px = cx + z.pos.x * sc, py = cy + z.pos.z * sc;
      if (py < 0) continue;
      const atk = z.state === 'attack';
      x.fillStyle = z.def.boss ? '#ff3a2a' : z.def.explode ? '#d8ff3a' : atk && blink ? '#ffffff' : '#ff5a44';
      x.beginPath(); x.arc(px, py, (z.def.boss ? 4.5 : z.def.wide ? 3 : 2.2) * s, 0, Math.PI * 2); x.fill();
    }
    for (const sv of g.survivors) {
      if (!sv.alive) continue;
      x.fillStyle = '#7bd66a';
      const px = cx + sv.pos.x * sc, py = cy + sv.pos.z * sc;
      x.beginPath(); x.moveTo(px, py - 3.5 * s); x.lineTo(px + 3 * s, py + 2.5 * s); x.lineTo(px - 3 * s, py + 2.5 * s); x.fill();
    }
    x.fillStyle = '#f0b13a';
    x.fillRect(cx - 2.5 * s, cy - 2.5 * s, 5 * s, 5 * s);
  }
}
