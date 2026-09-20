// DOM screens: main menu, pre-match setup, pause, halftime, full time.
// Each function renders into the overlay element and resolves/callbacks
// when the user makes a choice. Keeps all markup in one place.

import { CHARACTERS, STAT_KEYS, getCharacter } from '../data/characters.js';
import { TEAM_PRESETS } from '../data/teams.js';
import { JERSEYS, jerseysDistinct } from '../data/jerseys.js';
import { MODES, MODE_INFO, DURATION_OPTIONS, humanCount, humanTeamIndex } from '../game/config.js';
import { getAbility } from '../game/abilities.js';

const el = (tag, cls, html) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
};

export function showMenu(root, { onPlay, onHowTo }) {
  root.innerHTML = '';
  root.className = 'overlay menu';
  const box = el('div', 'panel');
  box.append(el('h1', 'title', 'GORILLA<span>FOOTBALL</span>'));
  box.append(el('p', 'subtitle', '11-a-side arcade football for one or two players on one device.'));
  const play = el('button', 'btn primary big', 'PLAY');
  play.onclick = onPlay;
  const how = el('button', 'btn ghost', 'How to play');
  how.onclick = onHowTo;
  box.append(play, how);
  box.append(el('p', 'foot', 'Original characters. Tap PLAY to set up a match.'));
  root.append(box);
  root.hidden = false;
}

export function showHowTo(root, onBack) {
  root.innerHTML = '';
  root.className = 'overlay';
  const box = el('div', 'panel scroll');
  box.append(el('h2', null, 'How to play'));
  box.append(el('div', 'body', `
    <p><b>Move</b> with the joystick on your side of the screen. Everything else is a button:</p>
    <ul>
      <li><b>PASS</b> — with the ball: pass to the teammate you are aiming at. Without it: tackle.</li>
      <li><b>SHOOT</b> — with the ball: shoot (aim up/down to place it). Without it: slide tackle.</li>
      <li><b>SPECIAL</b> — your character's signature move.</li>
    </ul>
    <p>At a restart the taker aims with the joystick and presses PASS or SHOOT. Wait too long and they play it automatically.</p>
    <p>You control one outfield player, marked with a ring. Goalkeepers and everyone else are AI.</p>
    <p><b>Keyboard (desktop):</b> P1 = WASD + J / K / L. P2 = arrow keys + 1 / 2 / 3. Esc pauses.</p>
    <p>Two-player matches use two separate control clusters so two people can hold the same device.</p>
  `));
  const back = el('button', 'btn', 'Back');
  back.onclick = onBack;
  box.append(back);
  root.append(box);
  root.hidden = false;
}

export function showSetup(root, initial, { onStart, onBack }) {
  const state = JSON.parse(JSON.stringify(initial));
  root.className = 'overlay';

  function render() {
    root.innerHTML = '';
    const box = el('div', 'panel scroll wide');
    box.append(el('h2', null, 'Match setup'));

    // Mode
    box.append(section('Game mode', modeRow()));
    const n = humanCount(state.mode);

    // Characters per human
    for (let i = 0; i < n; i++) box.append(section(`Player ${i + 1} character${n > 1 ? ` (${state.mode === MODES.COOP ? 'team 1' : `team ${humanTeamIndex(state.mode, i) + 1}`})` : ''}`, charRow(i)));

    // Teams + jerseys
    for (let t = 0; t < 2; t++) box.append(section(`Team ${t + 1}${humanTeams().includes(t) ? ' (you)' : ' (AI)'}`, teamRow(t)));

    // Duration
    box.append(section('Match length', durationRow()));

    const warn = el('div', 'warn');
    if (!jerseysDistinct(jersey(0), jersey(1))) warn.textContent = 'Pick two clearly different jerseys.';
    box.append(warn);

    const row = el('div', 'row end');
    const back = el('button', 'btn ghost', 'Back');
    back.onclick = onBack;
    const start = el('button', 'btn primary big', 'KICK OFF');
    start.disabled = !jerseysDistinct(jersey(0), jersey(1));
    start.onclick = () => onStart(JSON.parse(JSON.stringify(state)));
    row.append(back, start);
    box.append(row);
    root.append(box);
    root.hidden = false;
  }

  const jersey = (t) => JERSEYS.find((j) => j.id === state.teams[t].jerseyId) || JERSEYS[0];
  const humanTeams = () => {
    const out = [];
    for (let i = 0; i < humanCount(state.mode); i++) out.push(humanTeamIndex(state.mode, i));
    return [...new Set(out)];
  };

  function section(title, content) {
    const s = el('section');
    s.append(el('h3', null, title));
    s.append(content);
    return s;
  }

  function modeRow() {
    const row = el('div', 'chips');
    for (const m of MODE_INFO) {
      const b = el('button', 'chip' + (state.mode === m.id ? ' on' : ''), m.name);
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
      card.append(el('div', 'avatar', avatarSvg(c)));
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
      b.onclick = () => {
        state.teams[t].presetId = p.id;
        render();
      };
      teams.append(b);
    }
    wrap.append(teams);
    const kits = el('div', 'kits');
    for (const j of JERSEYS) {
      const other = jersey(1 - t);
      const b = el('button', 'kit' + (state.teams[t].jerseyId === j.id ? ' on' : '') + (j.id === other.id ? ' dim' : ''));
      b.style.background = j.primary;
      b.style.color = j.secondary;
      b.textContent = 'A';
      b.title = j.name;
      b.onclick = () => {
        state.teams[t].jerseyId = j.id;
        render();
      };
      kits.append(b);
    }
    wrap.append(kits);
    return wrap;
  }

  function durationRow() {
    const row = el('div', 'chips');
    for (const d of DURATION_OPTIONS) {
      const b = el('button', 'chip' + (state.durationMinutes === d ? ' on' : ''), `${d} min`);
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

function avatarSvg(c) {
  const { skin, accent } = c.look;
  return `<svg viewBox="0 0 40 40" width="40" height="40" aria-hidden="true">
    <circle cx="20" cy="22" r="13" fill="${accent}" stroke="rgba(0,0,0,.45)"/>
    <circle cx="20" cy="15" r="9" fill="${skin}" stroke="rgba(0,0,0,.35)"/>
    <circle cx="16.5" cy="14" r="1.6" fill="#111"/><circle cx="23.5" cy="14" r="1.6" fill="#111"/>
  </svg>`;
}
