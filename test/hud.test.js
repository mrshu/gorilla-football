import { test } from 'node:test';
import assert from 'node:assert/strict';
import { drawHud, getSpecialState } from '../src/ui/hud.js';
import { computeAimLayout } from '../src/ui/layout.js';
import { Match } from '../src/game/match.js';
import { normalizeConfig } from '../src/game/config.js';
import { STATES } from '../src/game/constants.js';
import { CHARACTERS } from '../src/data/characters.js';

function playingMatch(characterId = 'gorilla') {
  const match = new Match(normalizeConfig({ humans: [{ characterId }] }));
  match.state = STATES.PLAY;
  match.setPiece = null;
  match.ball.owner = match.humanPlayer(0).id;
  return match;
}

test('whole-team special readiness agrees with simulation ability activation', () => {
  for (const character of CHARACTERS) {
    for (const blocked of ['none', 'cooldown', 'uses', 'stun', 'frozen', 'stoppage', 'withoutBall']) {
      const match = playingMatch(character.id);
      const player = match.activePlayerFor(0);
      if (blocked === 'cooldown') player.ability.cooldown = 2.2;
      if (blocked === 'uses') player.ability.usesLeft = 0;
      if (blocked === 'stun') player.stun = 1;
      if (blocked === 'frozen') player.frozen = 1;
      if (blocked === 'stoppage') match.state = STATES.GOAL;
      if (blocked === 'withoutBall') match.ball.owner = null;
      const state = getSpecialState(match, 0);
      const selected = match.getPlayer(state.playerId);
      assert.equal(state.enabled, match.tryActivateAbility(selected), `${character.id} ${blocked}`);
    }
  }
});

test('whole-team special shows uses and cooldown after activation', () => {
  const match = playingMatch();
  const before = getSpecialState(match, 0);
  assert.equal(before.enabled, true);
  assert.equal(before.label, 'Jungle Thunder');
  assert.equal(before.uses, '10 left');
  const player = match.getPlayer(before.playerId);
  match.tryActivateAbility(player);
  // Restore possession so whole-team selection still points at this player.
  match.ball.owner = player.id;
  const after = getSpecialState(match, 0);
  assert.equal(after.enabled, false);
  assert.equal(after.status, '4s cooldown');
  assert.equal(after.uses, '9 left');
});

function textCanvas() {
  const texts = [];
  const labels = [];
  const noop = () => {};
  return {
    texts, labels,
    save: noop, restore: noop, fillRect: noop, beginPath: noop, arc: noop,
    fill: noop, stroke: noop, moveTo: noop, arcTo: noop, closePath: noop,
    fillText(text, x, y) {
      texts.push(text);
      labels.push({ text, x, y, align: this.textAlign, font: this.font });
    },
    measureText: (text) => ({ width: text.length * 6 }),
  };
}

test('HUD identifies carrier and then defender, and displays possession notification', () => {
  const match = playingMatch();
  const layout = computeAimLayout(390, 844, 1, 1);
  const canvas = textCanvas();
  drawHud(canvas, match, layout, { possessionNotices: [{ human: 0, text: 'POSSESSION WON' }] });
  assert.ok(canvas.texts.includes('Slow play · draw or tap ✓'));
  assert.ok(canvas.texts.includes('Possession won'));
  assert.ok(canvas.texts.includes('P1 special'));
  assert.ok(canvas.texts.includes('L'));
  assert.ok(canvas.texts.includes('Jungle Thunder'));
  canvas.texts.length = 0;
  match.ball.owner = match.teams[1].players[6].id;
  drawHud(canvas, match, layout);
  assert.ok(canvas.texts.includes('Defending · tap to press'));
  assert.ok(canvas.texts.some((text) => text.startsWith('P1 · #')));
});

test('match badges show the maths preference independently for each player', () => {
  const match = new Match(normalizeConfig({ mode: 'coop', humans: [
    { characterId: 'gorilla', mathsBand: 0 },
    { characterId: 'wizard', mathsBand: 5 },
  ] }));
  const layout = computeAimLayout(390, 844, 2, 1);
  const canvas = textCanvas();
  drawHud(canvas, match, layout);
  const off = canvas.labels.find((label) => label.text === 'Maths off');
  const on = canvas.labels.find((label) => label.text.startsWith('Maths on'));
  assert.ok(off && on, 'both enabled and disabled preferences remain visible');
  assert.ok(off.x < on.x, 'the P2 setting is shown in the P2 badge');
});

test('phone and versus HUDs keep long labels on screen without changing touch targets', () => {
  for (const mode of ['solo', 'versus']) {
    const match = new Match(normalizeConfig({ mode }));
    match.state = STATES.PLAY;
    match.setPiece = null;
    match.ball.owner = match.humanPlayer(0).id;
    match.teams[0].name = 'The extraordinarily long jungle football club';
    match.teams[1].name = 'The extraordinarily long pipeworks football club';
    const layout = computeAimLayout(390, 844, match.humanInputs.length, 1);
    const before = structuredClone(layout.specialButtons);
    const pause = { ...layout.pauseBtn };
    const canvas = textCanvas();
    drawHud(canvas, match, layout, { hint: 'Draw a kick · tap the tick to pass' });
    assert.deepEqual(layout.specialButtons, before);
    assert.deepEqual(layout.pauseBtn, pause);
    assert.ok(canvas.texts.some((text) => text.endsWith('…')), 'long team names use readable ellipsis');
    for (const label of canvas.labels) {
      const width = canvas.measureText(label.text).width;
      const left = label.x - (label.align === 'right' ? width : label.align === 'center' ? width / 2 : 0);
      assert.ok(left >= 0 && left + width <= layout.w, `label ${label.text} must fit on screen`);
      assert.ok(label.font.includes('Avenir Next'));
    }
    if (mode === 'versus') {
      assert.ok(canvas.texts.some((text) => text.startsWith('P2 · #')));
      assert.ok(canvas.texts.includes('P2 special'));
      assert.ok(canvas.texts.includes('3'));
    }
  }
});

test('HUD panels trace four nondegenerate rectangular corners, including the full special hit area', () => {
  const match = playingMatch();
  const layout = computeAimLayout(390, 844, 1, 1);
  const canvas = textCanvas();
  const paths = [];
  let corners = [];
  canvas.beginPath = () => { corners = []; };
  canvas.arcTo = (x, y, nextX, nextY) => {
    assert.ok(x !== nextX || y !== nextY, 'a rounded corner needs a distinct following edge');
    corners.push({ x, y });
  };
  canvas.fill = () => { if (corners.length) paths.push(corners.slice()); };
  drawHud(canvas, match, layout, { hint: 'Draw a kick', possessionNotices: [{ human: 0, text: 'Possession won' }] });
  assert.ok(paths.length >= 4, 'exercise badges, notices, special controls and hint panels');
  for (const path of paths) {
    assert.equal(path.length, 4, 'each panel has four rounded corners');
    const left = Math.min(...path.map((p) => p.x));
    const right = Math.max(...path.map((p) => p.x));
    const top = Math.min(...path.map((p) => p.y));
    const bottom = Math.max(...path.map((p) => p.y));
    let twiceArea = 0;
    for (let i = 0; i < path.length; i++) {
      const next = path[(i + 1) % path.length];
      twiceArea += path[i].x * next.y - next.x * path[i].y;
    }
    assert.equal(Math.abs(twiceArea) / 2, (right - left) * (bottom - top), 'the corners cover a rectangle, never a diagonal triangle');
  }
  const button = layout.specialButtons[0];
  assert.ok(paths.some((path) => Math.min(...path.map((p) => p.x)) === button.x
    && Math.max(...path.map((p) => p.x)) === button.x + button.w
    && Math.min(...path.map((p) => p.y)) === button.y
    && Math.max(...path.map((p) => p.y)) === button.y + button.h), 'the visible special panel covers the exact hit rectangle');
});
