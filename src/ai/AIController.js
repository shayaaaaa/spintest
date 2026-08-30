import { runEconomyAndBuildOrder } from './AIBuildOrder.js';
import { runArmyTactics } from './AICombatTactics.js';

const DEFAULT_DIFFICULTY = {
  decisionInterval: 1.2,   // seconds between AI decisions (~0.8Hz)
  aggressionInterval: 70,  // seconds between forced attacks even with a small army
  armySizeScale: 1,        // multiplies the idle-army-size attack threshold
  incomeMultiplier: 1,     // small passive resource trickle scalar
};

// One brain per AI player. Ticked every sim frame but internally gated to
// ~1Hz so decision-making cost doesn't scale with the 20Hz sim rate.
export class AIController {
  constructor(ownerId, difficulty = {}) {
    this.ownerId = ownerId;
    this.difficulty = { ...DEFAULT_DIFFICULTY, ...difficulty };
    this.timer = Math.random() * this.difficulty.decisionInterval; // stagger multiple AIs
    this.state = { attacking: false, lastAttackTime: 0, buildRingIndex: 0 };
  }

  update(ctx, dt) {
    this.timer -= dt;
    if (this.timer > 0) return;
    this.timer = this.difficulty.decisionInterval;

    const player = ctx.players[this.ownerId];
    if (!player) return;
    const hasTownHall = [...ctx.store.buildingsOf(this.ownerId)].some((b) => b.isTownHall);
    if (!hasTownHall) return; // defeated

    if (this.difficulty.incomeMultiplier > 1) {
      player.resources.materials += 2 * (this.difficulty.incomeMultiplier - 1);
    }

    runEconomyAndBuildOrder(ctx, this.ownerId, this.state);
    runArmyTactics(ctx, this.ownerId, this.state, this.difficulty);
  }
}
