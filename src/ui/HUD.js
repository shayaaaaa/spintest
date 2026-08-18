import { currentSupply } from '../systems/ProductionSystem.js';

export class HUD {
  constructor(ctx, selection) {
    this.ctx = ctx;
    this.selection = selection;
    this.materialsEl = document.getElementById('hudMaterials');
    this.energyEl = document.getElementById('hudEnergy');
    this.lumberEl = document.getElementById('hudLumber');
    this.supplyEl = document.getElementById('hudSupply');
    this.heroBadge = document.getElementById('heroBadge');
    this.heroLevelEl = document.getElementById('heroLevel');
    this.heroXpFill = document.getElementById('heroXpFill');
  }

  refresh() {
    const player = this.ctx.players[this.ctx.localPlayerId];
    if (!player) return;
    const flavor = player.race.resourceFlavor;
    this.materialsEl.textContent = `${Math.floor(player.resources.materials || 0)} ${flavor.materials}`;
    this.energyEl.textContent = `${Math.floor(player.resources.energy || 0)} ${flavor.energy}`;
    this.lumberEl.textContent = `${Math.floor(player.resources.lumber || 0)} ${flavor.lumber}`;
    const { used, cap } = currentSupply(this.ctx, this.ctx.localPlayerId);
    this.supplyEl.textContent = `${used} / ${cap}`;

    const hero = this.selection.entities(this.ctx.store).find((e) => e.isHero);
    if (hero) {
      this.heroBadge.classList.add('visible');
      this.heroLevelEl.textContent = `Lv.${hero.level}`;
      this.heroXpFill.style.width = `${Math.min(100, (hero.xp / hero.xpToNext) * 100)}%`;
    } else {
      this.heroBadge.classList.remove('visible');
    }
  }
}
