import { Game, racesById } from './game/Game.js';
import * as GameState from './game/GameState.js';
import { GameLoop } from './core/GameLoop.js';
import { Camera } from './render/Camera.js';
import { Renderer } from './render/Renderer.js';
import { createEffectsState, addHitFlash, updateEffects } from './render/layers/EffectsLayer.js';
import { TouchInput } from './input/TouchInput.js';
import { InputMapper } from './input/InputMapper.js';
import { SelectionManager } from './input/SelectionManager.js';
import { confirmPlacement, cancelPlacement, refreshValidity } from './input/BuildPlacementController.js';
import { castAbility } from './systems/AbilitySystem.js';
import { HUD } from './ui/HUD.js';
import { ActionBar } from './ui/ActionBar.js';
import { Minimap } from './ui/Minimap.js';
import { TooltipCard } from './ui/TooltipCard.js';
import { MenuScreens } from './ui/MenuScreens.js';

const canvas = document.getElementById('gameCanvas');
const renderer = new Renderer(canvas);

let game = null;
let view = null;
let hud = null, actionBar = null, minimap = null, tooltip = null, touchInput = null;
let loop = null;
let uiRefreshAccumulator = 0;
const UI_REFRESH_INTERVAL = 0.15;

function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  renderer.resize(w, h, dpr);
  if (view) {
    view.camera.resize(w, h);
    view.camera.clamp();
  }
}
window.addEventListener('resize', resize);
window.addEventListener('orientationchange', resize);
resize();

function otherRaceId(excludeId) {
  const ids = Object.keys(racesById).filter((id) => id !== excludeId);
  return ids[Math.floor(Math.random() * ids.length)];
}

function buildView(gameInstance) {
  const camera = new Camera(window.innerWidth, window.innerHeight);
  camera.setBounds(gameInstance.map.width, gameInstance.map.height);
  const townHall = [...gameInstance.store.buildingsOf(gameInstance.localPlayerId)][0];
  if (townHall) { camera.x = townHall.x; camera.y = townHall.y; }

  const v = {
    camera,
    selection: new SelectionManager(gameInstance.eventBus),
    dragBox: null,
    buildGhost: null,
    abilityTargeting: null,
    effectsState: createEffectsState(),
  };

  v.onConfirmPlacement = () => { confirmPlacement(gameInstance, v); actionBar.refresh(); };
  v.onCancelPlacement = () => { cancelPlacement(v); actionBar.refresh(); };
  v.onBuildGhostMoved = () => refreshValidity(gameInstance, v.buildGhost);
  v.onAbilityTarget = (targetSpec) => {
    const targeting = v.abilityTargeting;
    if (!targeting) return;
    const hero = gameInstance.store.get(targeting.heroId);
    if (hero) castAbility(gameInstance, hero, targeting.abilityId, targetSpec);
    v.abilityTargeting = null;
    actionBar.refresh();
  };
  v.onLongPressEntity = (entity, screenPos) => tooltip.show(entity, screenPos);
  v.onLongPressEnd = () => tooltip.hide();

  return v;
}

function startGame(localRaceId) {
  game = new Game({
    levelId: 'skirmish_1v1',
    localPlayerId: 0,
    participants: [
      { ownerId: 0, raceId: localRaceId, isAI: false },
      { ownerId: 1, raceId: otherRaceId(localRaceId), isAI: true },
    ],
  });
  afterGameReady();
}

function resumeGame() {
  const snapshot = GameState.loadFromLocalStorage();
  if (!snapshot) return startGame('cogforge');
  game = new Game({ levelId: snapshot.levelId, localPlayerId: 0, participants: [] });
  game.applySnapshot(snapshot);
  afterGameReady();
}

function afterGameReady() {
  window.__game = game; // dev/debug hook, see plan's verification section
  view = buildView(game);
  window.__view = view;
  resize();

  hud = new HUD(game, view.selection);
  actionBar = new ActionBar(game, view);
  minimap = new Minimap(game, view);
  tooltip = new TooltipCard();

  if (touchInput) {
    canvas.removeEventListener('pointerdown', touchInput._onDown);
    canvas.removeEventListener('pointermove', touchInput._onMove);
    canvas.removeEventListener('pointerup', touchInput._onUp);
    canvas.removeEventListener('pointercancel', touchInput._onUp);
  }
  const inputMapper = new InputMapper(game, view);
  touchInput = new TouchInput(canvas, inputMapper.callbacks());

  game.eventBus.on('unitDamaged', ({ target }) => addHitFlash(view.effectsState, target.x, target.y));
  game.eventBus.on('selectionChanged', () => actionBar.refresh());
  game.eventBus.on('resourcesChanged', () => actionBar.refresh());
  game.eventBus.on('techResearched', () => actionBar.refresh());
  game.eventBus.on('gameOver', (result) => {
    loop.stop();
    menus.showGameOver(result.winnerId === game.localPlayerId);
  });

  menus.hideMainMenu();
  menus.hidePause();
  hud.refresh();
  actionBar.refresh();
  loop.start();
}

function quitToMenu() {
  if (loop) loop.stop();
  game = null;
  view = null;
  menus.showMainMenu();
}

const menus = new MenuScreens({
  racesById,
  onStart: (raceId) => startGame(raceId),
  onResume: () => resumeGame(),
  onSave: () => { GameState.saveToLocalStorage(game); },
  onQuit: () => quitToMenu(),
  onResumeFromPause: () => loop.start(),
});

document.getElementById('pauseBtn').addEventListener('click', () => {
  if (loop) loop.stop();
});

loop = new GameLoop({
  onTick: (dt) => {
    if (!game) return;
    game.tick(dt);
    view.selection.prune(game.store);
    updateEffects(view.effectsState);
  },
  onRender: (alpha) => {
    if (!game) return;
    renderer.render(game, view);
    uiRefreshAccumulator += 1 / 60;
    if (uiRefreshAccumulator >= UI_REFRESH_INTERVAL) {
      uiRefreshAccumulator = 0;
      hud.refresh();
      actionBar.refresh();
      minimap.refresh();
    }
  },
});

menus.showMainMenu();
