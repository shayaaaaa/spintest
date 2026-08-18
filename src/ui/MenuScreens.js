import { hasSavedGame } from '../game/GameState.js';

const RACES = ['cogforge', 'thornback', 'vharn'];

export class MenuScreens {
  constructor({ racesById, onStart, onResume, onSave, onQuit, onResumeFromPause }) {
    this.racesById = racesById;
    this.selectedRaceId = 'cogforge';
    this.onStart = onStart;
    this.onResume = onResume;
    this.onSave = onSave;
    this.onQuit = onQuit;
    this.onResumeFromPause = onResumeFromPause;

    this.mainMenu = document.getElementById('mainMenu');
    this.pauseMenu = document.getElementById('pauseMenu');
    this.gameOverScreen = document.getElementById('gameOverScreen');
    this.raceGrid = document.getElementById('raceGrid');
    this.resumeBtn = document.getElementById('resumeBtn');

    this._buildRaceGrid();
    document.getElementById('startBtn').onclick = () => this.onStart(this.selectedRaceId);
    this.resumeBtn.onclick = () => this.onResume();
    document.getElementById('pauseBtn').onclick = () => this.showPause();
    document.getElementById('resumeFromPauseBtn').onclick = () => { this.hidePause(); this.onResumeFromPause(); };
    document.getElementById('saveBtn').onclick = () => this.onSave();
    document.getElementById('quitBtn').onclick = () => { this.hidePause(); this.onQuit(); };
    document.getElementById('playAgainBtn').onclick = () => { this.hideGameOver(); this.onQuit(); };
  }

  _buildRaceGrid() {
    this.raceGrid.innerHTML = '';
    for (const id of RACES) {
      const race = this.racesById[id];
      const card = document.createElement('div');
      card.className = 'race-card' + (id === this.selectedRaceId ? ' selected' : '');
      card.innerHTML = `<div class="swatch" style="background:${race.color}"></div>${race.name}`;
      card.onclick = () => {
        this.selectedRaceId = id;
        [...this.raceGrid.children].forEach((c) => c.classList.remove('selected'));
        card.classList.add('selected');
      };
      this.raceGrid.appendChild(card);
    }
  }

  showMainMenu() {
    this.resumeBtn.classList.toggle('hidden', !hasSavedGame());
    this.mainMenu.classList.remove('hidden');
  }
  hideMainMenu() { this.mainMenu.classList.add('hidden'); }

  showPause() { this.pauseMenu.classList.remove('hidden'); }
  hidePause() { this.pauseMenu.classList.add('hidden'); }

  showGameOver(won) {
    document.getElementById('gameOverTitle').textContent = won ? 'Victory!' : 'Defeat';
    this.gameOverScreen.classList.remove('hidden');
  }
  hideGameOver() { this.gameOverScreen.classList.add('hidden'); }
}
