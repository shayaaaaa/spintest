# Deadeye Outpost

A zombie sniper defense game for iPhone (and any modern browser). You hold a watchtower behind a wooden wall and pick off the infected through a scope before they tear the wall down.

Everything runs locally: 3D models are generated in code, sounds are synthesized, and a service worker caches every file so the game works with no connection after the first load.

## Play it on iPhone, offline

1. Host this `sniper/` folder anywhere that serves HTTPS (GitHub Pages works).
2. Open the page in **Safari**, tap **Share**, then **Add to Home Screen**.
3. Launch it once from the home screen while online. After that it runs offline, full screen.

Progress (cash, rifles, upgrades, stars) is saved on the device.

## Controls

| Action | Touch | Keyboard / mouse |
| --- | --- | --- |
| Aim | Drag anywhere (or drag from the fire button) | Mouse drag, WASD / arrows |
| Fire | Red button (hold for automatics and semi-autos) | Space or F |
| Scope / aim down sights | Crosshair button | E, Q, Shift or right-click |
| Zoom (snipers) | Slider on the left while scoped | Mouse wheel |
| Reload | Circular arrow | R |
| Switch weapon | Weapon bar under the item buttons | 1 / 2 / 3 / 4 |
| Focus / Mortar / Repair | Item buttons, top right | Z / X / C |

## What's in it

- 24 campaign missions across three maps (farmland at noon, a town at dusk, a harbor at night): defend, rescue and boss missions, rated with up to three stars.
- Survival mode with endless waves and a boss every 10th wave.
- Four weapon classes, and you carry one of each into every mission:
  - **Snipers** (6): long range, scope zoom, headshots; magnum rounds pierce several targets.
  - **Automatics** (3): hold to fire, red-dot sight, damage falls off past 35 to 50 m, spread grows during long bursts (the crosshair shows it).
  - **Pistols** (3): always carried, swap in a quarter of a second, never run out.
  - **Rockets** (2): unlimited rockets with a long reload and a splash blast. A rocket that lands next to your own wall damages it.
- Reloads keep running in the background after you switch weapons, so you can fire a rocket and go back to sniping while it reloads.
- Every weapon has damage, magazine, reload and a class-specific fourth upgrade (stability, control or blast radius).
- Five infected types: walkers, runners, brutes, helmeted soldiers (aim for the face) and bloaters that explode.
- Headshot dismemberment, slow-motion bullet kill cam on the final and boss kills, radar, wall damage, and field items.

## Files

- `index.html`: layout, styles and HUD
- `js/game.js`: gameplay, enemies, survivors, shooting and kill cam
- `js/world.js`: procedural maps
- `js/models.js`: characters, weapons and the rocket
- `js/fx.js`: blood, dust, explosions and debris
- `js/ui.js`: menus, armory, HUD, scope and radar
- `js/audio.js`: synthesized sound
- `js/data.js`: weapons, enemies and missions (tweak balance here)
- `sw.js`: offline cache. Bump `CACHE` when you change any file so phones pick up the update.

Fonts: Saira Condensed and Saira Stencil One (SIL Open Font License, see `fonts/OFL.txt`). 3D: three.js r160 (MIT).
