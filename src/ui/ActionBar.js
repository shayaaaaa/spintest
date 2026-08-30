import { enqueueTrain, enqueueResearch, canAfford, currentSupply } from '../systems/ProductionSystem.js';
import { startPlacement } from '../input/BuildPlacementController.js';
import { setStance } from '../systems/CombatSystem.js';
import { castAbility, learnAbility } from '../systems/AbilitySystem.js';

const STANCES = [
  { id: 'aggressive', label: 'Aggr.' },
  { id: 'defensive', label: 'Def.' },
  { id: 'holdPosition', label: 'Hold' },
  { id: 'passive', label: 'Passive' },
];

export class ActionBar {
  constructor(ctx, view) {
    this.ctx = ctx;
    this.view = view;
    this.el = document.getElementById('actionBar');
    this.selectionInfoEl = document.getElementById('selectionInfo');
  }

  refresh() {
    const selected = this.view.selection.entities(this.ctx.store);
    this.el.innerHTML = '';
    this._refreshSelectionInfo(selected);

    if (this.view.buildGhost) return this._renderPlacementControls();
    if (this.view.abilityTargeting) return this._renderTargetingControls();
    if (selected.length === 0) return;

    const building = selected.find((e) => e.kind === 'building' && e.ownerId === this.ctx.localPlayerId);
    if (building) return this._renderBuildingBar(building);

    const units = selected.filter((e) => e.kind === 'unit' && e.ownerId === this.ctx.localPlayerId);
    if (units.length > 0) this._renderUnitBar(units);
  }

  _refreshSelectionInfo(selected) {
    this.selectionInfoEl.innerHTML = '';
    for (const e of selected.slice(0, 12)) {
      const chip = document.createElement('div');
      chip.className = 'unit-chip';
      chip.innerHTML = `<strong>${e.name}</strong><span>${Math.round(e.hp)}/${e.maxHp} HP</span>`;
      this.selectionInfoEl.appendChild(chip);
    }
  }

  _renderPlacementControls() {
    this.el.appendChild(this._btn({
      icon: '✔', label: 'Build', className: 'confirm',
      onClick: () => this.view.onConfirmPlacement?.(),
    }));
    this.el.appendChild(this._btn({
      icon: '✕', label: 'Cancel', className: 'cancel',
      onClick: () => this.view.onCancelPlacement?.(),
    }));
  }

  _renderTargetingControls() {
    this.el.appendChild(this._btn({
      icon: '✕', label: 'Cancel Cast', className: 'cancel',
      onClick: () => { this.view.abilityTargeting = null; this.refresh(); },
    }));
  }

  _renderBuildingBar(building) {
    const player = this.ctx.players[building.ownerId];
    const race = this.ctx.racesById[player.raceId];

    if (building.underConstruction) {
      const pct = Math.round(building.constructionProgress * 100);
      this.el.appendChild(this._info(`Building… ${pct}%`));
      return;
    }

    if (building.queue.length > 0) {
      const job = building.queue[0];
      const pct = Math.round((1 - job.timeLeft / job.totalTime) * 100);
      this.el.appendChild(this._info(`${job.kind === 'unit' ? 'Training' : 'Researching'}… ${pct}% (+${building.queue.length - 1} queued)`));
    }

    for (const unitId of building.trains || []) {
      const def = race.units[unitId] || race.heroes?.[unitId];
      if (!def) continue;
      const locked = def.requiresTech && !player.researchedTech.has(def.requiresTech);
      const { used, cap } = currentSupply(this.ctx, building.ownerId);
      const supplyFull = used + (def.supplyCost ?? 1) > cap;
      const disabled = locked || !canAfford(player, def.cost) || supplyFull;
      this.el.appendChild(this._btn({
        icon: '⚙', label: def.name, cost: costLabel(def.cost),
        disabled, title: locked ? 'Requires research' : supplyFull ? 'Supply full' : '',
        onClick: () => { enqueueTrain(this.ctx, building, unitId); this.refresh(); },
      }));
    }

    const techtree = this.ctx.techtreesById[race.techtreeId];
    for (const techId of building.researches || []) {
      const def = techtree[techId];
      if (!def || player.researchedTech.has(techId)) continue;
      const prereqOk = def.requires.every((r) => player.researchedTech.has(r));
      const disabled = !prereqOk || !canAfford(player, def.cost);
      this.el.appendChild(this._btn({
        icon: '🧪', label: def.name, cost: costLabel(def.cost), disabled,
        onClick: () => { enqueueResearch(this.ctx, building, techId); this.refresh(); },
      }));
    }
  }

  _renderUnitBar(units) {
    const player = this.ctx.players[this.ctx.localPlayerId];
    const race = this.ctx.racesById[player.raceId];

    if (units.some((u) => u.canBuild)) {
      for (const buildingId of Object.keys(race.buildings)) {
        const def = race.buildings[buildingId];
        if (def.isTownHall) continue;
        const locked = def.requiresTech && !player.researchedTech.has(def.requiresTech);
        const disabled = locked || !canAfford(player, def.cost);
        this.el.appendChild(this._btn({
          icon: '🔨', label: def.name, cost: costLabel(def.cost), disabled,
          title: locked ? 'Requires research' : '',
          onClick: () => {
            startPlacement(this.ctx, this.view, this.ctx.localPlayerId, buildingId);
            this.refresh();
          },
        }));
      }
    }

    const combatUnits = units.filter((u) => u.dmgMax > 0);
    if (combatUnits.length > 0) {
      const wrap = document.createElement('div');
      wrap.className = 'stance-row';
      wrap.style.flex = '0 0 auto';
      for (const s of STANCES) {
        const b = document.createElement('button');
        b.className = 'stance-btn' + (combatUnits[0].stance === s.id ? ' active' : '');
        b.textContent = s.label;
        b.onclick = () => { for (const u of combatUnits) setStance(u, s.id); this.refresh(); };
        wrap.appendChild(b);
      }
      this.el.appendChild(wrap);
    }

    const hero = units.find((u) => u.isHero);
    if (hero) this._renderHeroAbilities(hero);
  }

  _renderHeroAbilities(hero) {
    for (const entry of hero.abilities) {
      const def = this.ctx.abilities[entry.id];
      const learned = entry.level > 0;
      const canLearn = !learned && hero.abilityPoints > 0;
      const btn = this._btn({
        icon: '✨', label: def.name + (learned ? ` L${entry.level}` : ''),
        cost: learned ? costLabel(def.cost) : `${hero.abilityPoints} pt`,
        disabled: !learned && !canLearn,
        onClick: () => {
          if (!learned) {
            learnAbility(this.ctx, hero, entry.id);
            this.refresh();
            return;
          }
          if (entry.cooldownLeft > 0) return;
          if (def.targeting === 'self') {
            castAbility(this.ctx, hero, entry.id, { id: hero.id, x: hero.x, y: hero.y });
          } else {
            this.view.abilityTargeting = { heroId: hero.id, abilityId: entry.id, targeting: def.targeting };
            this.refresh();
          }
        },
      });
      if (learned && entry.cooldownLeft > 0) {
        const veil = document.createElement('div');
        veil.className = 'cooldown-veil';
        veil.textContent = Math.ceil(entry.cooldownLeft);
        btn.appendChild(veil);
      }
      this.el.appendChild(btn);
    }
  }

  _btn({ icon, label, cost, disabled, title, className, onClick }) {
    const b = document.createElement('button');
    b.className = 'action-btn' + (className ? ` ${className}` : '');
    b.disabled = !!disabled;
    if (title) b.title = title;
    b.innerHTML = `<span class="icon">${icon}</span><span>${label}</span>${cost ? `<span class="cost">${cost}</span>` : ''}`;
    b.onclick = onClick;
    return b;
  }

  _info(text) {
    const d = document.createElement('div');
    d.className = 'unit-chip';
    d.textContent = text;
    return d;
  }
}

function costLabel(cost) {
  return Object.entries(cost || {}).map(([, v]) => `${v}`).join('/');
}
