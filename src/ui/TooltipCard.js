// Tap-and-hold info popover for units/buildings, shown via
// InputMapper's onLongPressEntity/onLongPressEnd hooks.
export class TooltipCard {
  constructor() {
    this.el = document.getElementById('tooltipCard');
  }

  show(entity, screenPos) {
    const owner = entity.ownerId !== undefined ? ` · Owner ${entity.ownerId}` : '';
    const hpLine = entity.hp !== undefined ? `<p>${Math.round(entity.hp)} / ${entity.maxHp} HP</p>` : '';
    const roleLine = entity.role ? `<p>${entity.role}${owner}</p>` : '';
    this.el.innerHTML = `<h4>${entity.name || entity.resourceType || 'Entity'}</h4>${roleLine}${hpLine}`;
    const x = Math.min(screenPos.x + 12, window.innerWidth - 232);
    const y = Math.max(8, screenPos.y - 60);
    this.el.style.left = `${x}px`;
    this.el.style.top = `${y}px`;
    this.el.classList.add('visible');
  }

  hide() {
    this.el.classList.remove('visible');
  }
}
