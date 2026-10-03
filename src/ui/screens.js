// DOM screens: main menu, pre-match setup, pause, halftime, full time.
// Each function renders into the overlay element and resolves/callbacks
// when the user makes a choice. Keeps all markup in one place.

import { CHARACTERS, STAT_KEYS, getCharacter } from '../data/characters.js';
import { TEAM_PRESETS } from '../data/teams.js';
import { JERSEYS, jerseysDistinct } from '../data/jerseys.js';
import { MODES, MODE_INFO, CONTROL, CONTROL_INFO, VIEW_INFO, DURATION_OPTIONS, humanCount, humanTeamIndex } from '../game/config.js';
import { getAbility } from '../game/abilities.js';
import { computeDecisionLayout } from './decision-layout.js';

const el = (tag, cls, html) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
};

export function showMenu(root, { onPlay, onHowTo }) {
  root.innerHTML = '';
  root.className = 'overlay menu';
  const box = el('div', 'panel menu-panel');
  const eyebrow = el('div', 'menu-eyebrow');
  eyebrow.append(el('span', null, 'Night League'));
  box.append(eyebrow);
  box.append(el('h1', 'title', 'GORILLA<span>FOOTBALL</span>'));
  box.append(el('p', 'subtitle', 'Pick your squad. Draw your passes. Play under the lights.'));

  const play = el('button', 'btn primary big', 'Play football');
  play.onclick = onPlay;
  const how = el('button', 'btn ghost', 'Read the playbook');
  how.onclick = onHowTo;
  const actions = el('div', 'menu-actions');
  actions.append(play, how);
  box.append(actions);

  const meta = el('div', 'menu-meta');
  meta.append(el('div', null, '<b>11</b><span>players a side</span>'));
  meta.append(el('div', null, '<b>1 or 2</b><span>players on one device</span>'));
  meta.append(el('div', null, '<b>Optional</b><span>maths practice</span>'));
  box.append(meta);
  root.append(box);
  root.hidden = false;
}

export function showHowTo(root, onBack) {
  root.innerHTML = '';
  root.className = 'overlay';
  const box = el('div', 'panel scroll');
  box.append(el('h2', null, 'How to play'));
  box.append(el('div', 'body', `
    <h4>Whole team (default)</h4>
    <p>You run the whole side from a stadium camera. Every footballer moves themselves; your job is the ball.</p>
    <ul>
      <li><b>Tap the grass</b> to send your player running there. With the ball at their feet they dribble to the spot.</li>
      <li><b>Tap an opponent</b> who has the ball to get stuck in.</li>
      <li><b>Draw a line</b> with your finger and release. The ball is struck towards where the line ended.</li>
      <li><b>Tap the tick</b> to play the suggested pass or shot.</li>
    </ul>
    <p>The kick itself is real football physics. A short line is driven along the grass hard enough to arrive and stop there; a long one is lifted and dropped on the spot. Draw further than your player can kick and it falls short, as it would.</p>
    <p>A simple curved line adds bounded curl. Loops and backtracking add no artificial spin, and a closed stroke is ignored.</p>
    <p>There is no separate pass and shoot. Draw a line that ends in the net and that was a shot.</p>
    <p>Possession slows play immediately, giving you time to choose. Drawing a kick freezes play and the camera; releasing it resumes play.</p>
    <p>Once you carry the ball inside thirty metres of goal the camera drops in behind you, low and facing the goal, to line up the shot. A yellow tick marks where the game reckons the ball should go next.</p>
    <p>The camera is a <b>side view</b> by default, the way football is televised. First person, looking out from your own player, is a setting on the pre-match screen.</p>
    <p>Your free kicks and penalties use the taker's <b>first-person view</b> while you line up the kick and follow the ball. The view stays steady while you draw, then returns to your chosen camera at the next possession or stoppage.</p>
    <p>The player on the ball is ringed. Untaken restarts are played automatically after a few seconds.</p>
    <p>Restarts work the same way: aim and release to take the throw, corner, free kick or penalty.</p>
    <h4>One player</h4>
    <p>The older control styles are still here if you prefer them. Both give you a single outfield player, marked with a ring, seen from straight above.</p>
    <p>You drive your player yourself with the joystick on your side of the screen. Touch anywhere in the joystick zone to put the stick under your thumb. Nothing ever pauses.</p>
    <ul>
      <li><b>PASS</b> — with the ball: pass to whoever you are aiming at. Without it: tackle.</li>
      <li><b>SHOOT</b> — with the ball: shoot, aiming up or down to place it. Without it: slide tackle.</li>
      <li><b>SPECIAL</b> — your character's signature move.</li>
    </ul>
    <p>At a restart the taker aims with the joystick and presses PASS or SHOOT; wait too long and they play it automatically.</p>
    <h4>One player, paced</h4>
    <p>Your player runs themselves, like every other footballer on the pitch. The match <b>freezes</b> whenever you have a real choice: when you win the ball, when you reach shooting range, when an opponent closes you down, and at every restart you take.</p>
    <p>A panel then offers your options. Passes show the teammate, the distance and whether they are free, and the lines on the pitch show where each ball would go.</p>
    <ul>
      <li><b>SHOOT</b> — have a go at goal.</li>
      <li><b>PASS #n</b> — play it to that teammate.</li>
      <li><b>SPECIAL</b> — your character's signature move.</li>
      <li><b>DRIBBLE</b> — carry on and decide a moment later.</li>
    </ul>
    <p>Between decisions you can still steer with the joystick and use the buttons whenever you like. Nothing forces you to wait for the panel.</p>
    <p><b>Keyboard (desktop):</b> P1 = WASD + J / K / L. P2 = arrow keys + 1 / 2 / 3. Esc pauses.</p>
    <p>Two-player matches give each person their own joystick and buttons so two people can hold the same device.</p>
    <h4>Optional maths practice</h4>
    <p>Choose a starting age for each player before kickoff. Occasional questions pause play during attacking possession. You can always skip; wrong answers reveal the answer and cost no turn.</p>
    <p>A correct answer earns a <b>Focused kick</b>: your next pass or shot has less aiming error. The bonus lasts for this possession. Speed, loft and curl keep their usual physics.</p>
    <p>Difficulty adapts to each player's answers and progress stays on this device. Switching maths off retains that progress; selecting a different starting age starts that player's practice afresh.</p>
  `));
  const back = el('button', 'btn', 'Back');
  back.onclick = onBack;
  box.append(back);
  root.append(box);
  root.hidden = false;
}

export function showSetup(root, initial, { onStart, onBack }) {
  const state = JSON.parse(JSON.stringify(initial));
  root.className = 'overlay setup';

  function render() {
    const scrollTop = root.querySelector('.setup-content')?.scrollTop || 0;
    const focusKey = root.contains(document.activeElement) ? document.activeElement.dataset.setupFocus : null;
    root.innerHTML = '';
    const box = el('div', 'panel wide setup-panel');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-labelledby', 'setup-title');
    const header = el('header', 'setup-header');
    const title = el('h2', 'setup-title', 'Match setup');
    title.id = 'setup-title';
    header.append(title, el('p', 'subtitle', 'Choose your players and how you want to play.'));
    box.append(header);

    const content = el('div', 'setup-content');
    const settings = el('div', `setup-settings${state.control === CONTROL.AIM ? ' with-camera' : ''}`);
    settings.append(section('Game mode', modeRow(), 'setup-field setup-mode'));
    settings.append(section('Control style', controlRow()));
    if (state.control === CONTROL.AIM) settings.append(section('Camera', viewRow()));
    settings.append(section('Match length', durationRow()));
    content.append(settings);

    const n = humanCount(state.mode);
    const squads = el('div', 'setup-squads');
    const players = el('section', 'setup-players');
    players.append(el('h2', 'setup-group-title', n === 1 ? 'Your player' : 'Your players'));
    const playerGrid = el('div', `setup-player-grid${n === 1 ? ' solo' : ''}`);

    // Characters per human
    for (let i = 0; i < n; i++) {
      const player = el('section', `setup-player player-${i + 1}`);
      const playerHeader = el('div', 'setup-player-header');
      playerHeader.append(el('h3', null, `Player ${i + 1}`));
      playerHeader.append(el('span', 'setup-player-team', `Team ${humanTeamIndex(state.mode, i) + 1}`));
      player.append(playerHeader);
      player.append(section('Character', charRow(i), 'setup-field player-character', 'h4'));
      player.append(section('Maths practice', mathsRow(i), 'setup-field player-maths', 'h4'));
      playerGrid.append(player);
    }
    players.append(playerGrid);
    squads.append(players);

    // Teams + jerseys
    const teams = el('section', 'setup-teams');
    teams.append(el('h2', 'setup-group-title', 'Teams and kits'));
    for (let t = 0; t < 2; t++) teams.append(section(`Team ${t + 1} · ${humanTeams().includes(t) ? 'you' : 'AI'}`, teamRow(t), 'setup-team'));
    squads.append(teams);
    content.append(squads);
    box.append(content);

    const footer = el('footer', 'setup-footer');
    const summary = el('div', 'setup-summary');
    const controls = CONTROL_INFO.find((c) => c.id === state.control) || CONTROL_INFO[0];
    summary.append(el('p', null, `${n === 1 ? '1 player' : '2 players'} · ${controls.name} · ${state.durationMinutes} min`));
    const warn = el('div', 'warn');
    warn.id = 'setup-warning';
    warn.setAttribute('role', 'status');
    if (!jerseysDistinct(jersey(0), jersey(1))) warn.textContent = 'Pick two clearly different jerseys.';
    summary.append(warn);
    footer.append(summary);

    const row = el('div', 'setup-actions');
    const back = el('button', 'btn ghost', 'Back');
    back.onclick = onBack;
    const start = el('button', 'btn primary big', 'Kick off');
    start.disabled = !jerseysDistinct(jersey(0), jersey(1));
    if (start.disabled) start.setAttribute('aria-describedby', warn.id);
    start.onclick = () => onStart(JSON.parse(JSON.stringify(state)));
    row.append(back, start);
    footer.append(row);
    box.append(footer);
    root.append(box);
    root.hidden = false;
    content.scrollTop = scrollTop;
    if (focusKey) root.querySelector(`[data-setup-focus="${focusKey}"]`)?.focus({ preventScroll: true });
  }

  const jersey = (t) => JERSEYS.find((j) => j.id === state.teams[t].jerseyId) || JERSEYS[0];
  const humanTeams = () => {
    const out = [];
    for (let i = 0; i < humanCount(state.mode); i++) out.push(humanTeamIndex(state.mode, i));
    return [...new Set(out)];
  };

  function section(title, content, className = 'setup-field', heading = 'h3') {
    const s = el('section', className);
    s.append(el(heading, null, title));
    s.append(content);
    return s;
  }

  function modeRow() {
    const row = el('div', 'chips');
    for (const m of MODE_INFO) {
      const b = el('button', 'chip' + (state.mode === m.id ? ' on' : ''), m.name);
      b.setAttribute('aria-pressed', String(state.mode === m.id));
      b.dataset.setupFocus = `mode-${m.id}`;
      b.onclick = () => {
        state.mode = m.id;
        render();
      };
      row.append(b);
    }
    return row;
  }

  function charRow(i) {
    const wrap = el('div');
    const row = el('div', 'cards');
    for (const c of CHARACTERS) {
      const sel = state.humans[i].characterId === c.id;
      const card = el('button', 'card' + (sel ? ' on' : ''));
      card.setAttribute('aria-label', c.name);
      card.setAttribute('aria-pressed', String(sel));
      card.dataset.setupFocus = `character-${i}-${c.id}`;
      const avatar = el('div', 'avatar');
      const portrait = document.createElement('img');
      portrait.src = `public/assets/player-sprite-${c.id}.png`;
      portrait.alt = '';
      portrait.decoding = 'async';
      avatar.append(portrait);
      card.append(avatar);
      card.append(el('div', 'cname', c.name));
      card.onclick = () => {
        state.humans[i].characterId = c.id;
        render();
      };
      row.append(card);
    }
    wrap.append(row);
    const c = getCharacter(state.humans[i].characterId);
    const ab = getAbility(c.abilityId);
    const info = el('div', 'info');
    info.append(el('div', 'ability', `<b>${ab.name}</b> — ${ab.description}`));
    info.append(statBars(c));
    wrap.append(info);
    return wrap;
  }

  function mathsRow(i) {
    const wrap = el('div', 'maths-setup');
    const label = el('label');
    label.textContent = 'Starting age';
    label.htmlFor = `maths-band-${i + 1}`;
    const select = el('select', 'maths-band');
    select.id = label.htmlFor;
    select.setAttribute('aria-label', `Player ${i + 1} maths starting age`);
    const options = [
      'Off — just football', 'Age 5 · counting', 'Age 6 · addition',
      'Age 7 · numbers to 20', 'Age 8 · multiplication', 'Age 9 · fractions',
      'Age 10 · decimals', 'Age 11 · percentages', 'Age 12 · equations',
      'Age 13 · algebra', 'Ages 14–15 · geometry', 'Age 16+ · advanced maths',
    ];
    options.forEach((name, band) => {
      const option = el('option');
      option.value = String(band);
      option.textContent = name;
      select.append(option);
    });
    select.value = String(state.humans[i].mathsBand || 0);
    select.onchange = () => { state.humans[i].mathsBand = Number(select.value); };
    const hint = el('p', 'foot');
    hint.textContent = 'Occasional, skippable questions earn a more accurate kick. Difficulty adapts to each player and progress stays on this device.';
    wrap.append(label, select, hint);
    return wrap;
  }

  function statBars(c) {
    const g = el('div', 'stats');
    for (const k of STAT_KEYS) {
      const r = el('div', 'stat');
      r.append(el('span', 'k', k.replace(/([A-Z])/g, ' $1').toLowerCase()));
      const bar = el('span', 'bar');
      const fill = el('i');
      fill.style.width = `${c.stats[k] * 10}%`;
      bar.append(fill);
      r.append(bar);
      r.append(el('span', 'v', String(c.stats[k])));
      g.append(r);
    }
    return g;
  }

  function teamRow(t) {
    const wrap = el('div');
    const teams = el('div', 'chips');
    for (const p of TEAM_PRESETS) {
      const b = el('button', 'chip' + (state.teams[t].presetId === p.id ? ' on' : ''), p.name);
      b.setAttribute('aria-pressed', String(state.teams[t].presetId === p.id));
      b.dataset.setupFocus = `team-${t}-${p.id}`;
      b.onclick = () => {
        state.teams[t].presetId = p.id;
        render();
      };
      teams.append(b);
    }
    wrap.append(teams);
    const kits = el('div', 'kits');
    kits.setAttribute('role', 'group');
    kits.setAttribute('aria-label', `Team ${t + 1} jersey colour`);
    for (const j of JERSEYS) {
      const other = jersey(1 - t);
      const b = el('button', 'kit' + (state.teams[t].jerseyId === j.id ? ' on' : '') + (j.id === other.id ? ' dim' : ''));
      b.style.background = j.primary;
      b.style.color = j.secondary;
      b.textContent = 'A';
      b.title = j.name;
      b.setAttribute('aria-label', `${j.name} jersey`);
      b.setAttribute('aria-pressed', String(state.teams[t].jerseyId === j.id));
      b.dataset.setupFocus = `jersey-${t}-${j.id}`;
      b.onclick = () => {
        state.teams[t].jerseyId = j.id;
        render();
      };
      kits.append(b);
    }
    wrap.append(kits);
    return wrap;
  }

  function controlRow() {
    const wrap = el('div');
    const row = el('div', 'chips');
    for (const c of CONTROL_INFO) {
      const b = el('button', 'chip' + (state.control === c.id ? ' on' : ''), c.name);
      b.setAttribute('aria-pressed', String(state.control === c.id));
      b.dataset.setupFocus = `control-${c.id}`;
      b.onclick = () => {
        state.control = c.id;
        render();
      };
      row.append(b);
    }
    wrap.append(row);
    const info = CONTROL_INFO.find((c) => c.id === state.control) || CONTROL_INFO[0];
    wrap.append(el('p', 'foot', info.detail));
    return wrap;
  }

  function viewRow() {
    const wrap = el('div');
    const row = el('div', 'chips');
    for (const v of VIEW_INFO) {
      const b = el('button', 'chip' + (state.view === v.id ? ' on' : ''), v.name);
      b.setAttribute('aria-pressed', String(state.view === v.id));
      b.dataset.setupFocus = `view-${v.id}`;
      b.onclick = () => {
        state.view = v.id;
        render();
      };
      row.append(b);
    }
    wrap.append(row);
    const info = VIEW_INFO.find((v) => v.id === state.view) || VIEW_INFO[0];
    wrap.append(el('p', 'foot', info.detail));
    return wrap;
  }

  function durationRow() {
    const row = el('div', 'chips');
    for (const d of DURATION_OPTIONS) {
      const b = el('button', 'chip' + (state.durationMinutes === d ? ' on' : ''), `${d} min`);
      b.setAttribute('aria-pressed', String(state.durationMinutes === d));
      b.dataset.setupFocus = `duration-${d}`;
      b.onclick = () => {
        state.durationMinutes = d;
        render();
      };
      row.append(b);
    }
    return row;
  }

  render();
}


// The frozen decision panel. `flip` rotates it for a player sitting at the
// far end of the device in two-player portrait versus.
export function showDecision(root, match, decision, { onChoose, flip = false, layout = null }) {
  root.innerHTML = '';
  root.className = 'overlay decision';
  const reserved = layout || computeDecisionLayout(window.innerWidth, window.innerHeight, decision.options.length, { flip });
  root.style.setProperty('--decision-x', `${reserved.panel.x}px`);
  root.style.setProperty('--decision-y', `${reserved.panel.y}px`);
  root.style.setProperty('--decision-width', `${reserved.panel.w}px`);
  root.style.setProperty('--decision-height', `${reserved.panel.h}px`);
  root.style.setProperty('--decision-columns', reserved.columns);
  root.style.setProperty('--decision-row-height', `${reserved.rowHeight}px`);
  const player = match.getPlayer(decision.playerId);
  const sheet = el('div', `sheet p${decision.humanIndex + 1}${flip ? ' flip' : ''}`);

  const head = el('div', 'dhead');
  head.append(el('span', 'who', `P${decision.humanIndex + 1} · #${player.number} ${player.character.name}`));
  head.append(el('span', 'why', triggerLabel(decision)));
  sheet.append(head);

  const grid = el('div', 'dopts');
  grid.setAttribute('aria-label', 'Choose your next play');
  for (const o of decision.options) {
    const b = el('button', `dopt q-${o.quality || 'ok'}${o.disabled ? ' off' : ''}`);
    b.append(el('span', 'dlabel', o.label));
    b.append(el('span', 'ddetail', o.detail || ''));
    b.disabled = Boolean(o.disabled);
    b.setAttribute('aria-label', [o.label, o.detail].filter(Boolean).join(' · '));
    if (!o.disabled) b.onclick = () => onChoose({ id: o.id, targetId: o.targetId });
    grid.append(b);
  }
  sheet.append(grid);
  root.append(sheet);
  root.hidden = false;
}

function triggerLabel(d) {
  if (d.setPieceKind) {
    return {
      kickoff: 'Kick-off',
      throw_in: 'Throw-in',
      corner: 'Corner',
      goal_kick: 'Goal kick',
      free_kick: 'Free kick',
      penalty: 'Penalty',
    }[d.setPieceKind] || 'Restart';
  }
  return {
    possession: 'You won the ball',
    shooting_range: 'In shooting range',
    pressure: 'Under pressure',
    carrying: 'On the ball',
  }[d.trigger] || 'Your call';
}

export function showPause(root, match, { onResume, onRestart, onQuit }) {
  root.innerHTML = '';
  root.className = 'overlay dim';
  const box = el('div', 'panel');
  box.append(el('h2', null, 'Paused'));
  box.append(scoreLine(match));
  const resume = el('button', 'btn primary big', 'Resume');
  resume.onclick = onResume;
  const restart = el('button', 'btn', 'Restart match');
  restart.onclick = onRestart;
  const quit = el('button', 'btn ghost', 'Quit to menu');
  quit.onclick = onQuit;
  box.append(resume, restart, quit);
  root.append(box);
  root.hidden = false;
}

export function showHalftime(root, match, onContinue) {
  root.innerHTML = '';
  root.className = 'overlay dim';
  const box = el('div', 'panel');
  box.append(el('h2', null, 'Half time'));
  box.append(scoreLine(match));
  box.append(statsTable(match));
  box.append(el('p', 'foot', 'Teams change ends for the second half.'));
  const b = el('button', 'btn primary big', 'Second half');
  b.onclick = onContinue;
  box.append(b);
  root.append(box);
  root.hidden = false;
}

export function showFullTime(root, match, { onRematch, onMenu }) {
  root.innerHTML = '';
  root.className = 'overlay dim';
  const box = el('div', 'panel');
  const [a, b] = [match.teams[0].score, match.teams[1].score];
  box.append(el('h2', null, 'Full time'));
  box.append(scoreLine(match));
  box.append(el('p', 'result', a === b ? 'Draw' : `${match.teams[a > b ? 0 : 1].name} win`));
  box.append(statsTable(match));
  if (match.goals.length) {
    const list = el('div', 'goals');
    for (const g of match.goals) {
      const s = g.scorerId !== null ? match.getPlayer(g.scorerId) : null;
      list.append(el('div', 'goalrow', `${g.minute} · ${match.teams[g.team].name} — ${s ? `#${s.number} ${s.character.name}` : 'unknown'}${g.ownGoal ? ' (o.g.)' : ''}`));
    }
    box.append(list);
  }
  const r = el('button', 'btn primary big', 'Rematch');
  r.onclick = onRematch;
  const m = el('button', 'btn ghost', 'Main menu');
  m.onclick = onMenu;
  box.append(r, m);
  root.append(box);
  root.hidden = false;
}

function scoreLine(match) {
  const d = el('div', 'scoreline');
  const t0 = match.teams[0];
  const t1 = match.teams[1];
  d.innerHTML = `<span class="kit" style="background:${t0.jersey.primary}"></span>
    <span class="tn">${t0.name}</span>
    <b>${t0.score} – ${t1.score}</b>
    <span class="tn">${t1.name}</span>
    <span class="kit" style="background:${t1.jersey.primary}"></span>`;
  return d;
}

function statsTable(match) {
  const rows = [
    ['Shots', match.stats.shots],
    ['Fouls', match.stats.fouls],
    ['Offsides', match.stats.offsides],
    ['Saves', match.stats.saves],
    ['Specials', match.stats.specials],
    ['Cards', [count(match.cards, 0), count(match.cards, 1)]],
  ];
  const t = el('table', 'stats-table');
  for (const [label, [a, b]] of rows) {
    const tr = el('tr');
    tr.innerHTML = `<td>${a}</td><th>${label}</th><td>${b}</td>`;
    t.append(tr);
  }
  return t;
}

function count(cards, team) {
  return cards.filter((c) => c.team === team).length;
}
