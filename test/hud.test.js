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
  const noop = () => {};
  return {
    texts,
    save: noop, restore: noop, fillRect: noop, beginPath: noop, arc: noop,
    fill: noop, stroke: noop, moveTo: noop, arcTo: noop, closePath: noop,
    fillText: (text) => texts.push(text),
    measureText: (text) => ({ width: text.length * 6 }),
  };
}

test('HUD identifies carrier and then defender, and displays possession notification', () => {
  const match = playingMatch();
  const layout = computeAimLayout(390, 844, 1, 1);
  const canvas = textCanvas();
  drawHud(canvas, match, layout, { possessionNotices: [{ human: 0, text: 'POSSESSION WON' }] });
  assert.ok(canvas.texts.includes('PLAY SLOWED · DRAW TO KICK'));
  assert.ok(canvas.texts.includes('POSSESSION WON'));
  assert.ok(canvas.texts.includes('P1 SPECIAL [L]'));
  assert.ok(canvas.texts.includes('Jungle Thunder'));
  canvas.texts.length = 0;
  match.ball.owner = match.teams[1].players[6].id;
  drawHud(canvas, match, layout);
  assert.ok(canvas.texts.includes('DEFENDING · TAP TO PRESS'));
  assert.ok(canvas.texts.some((text) => text.startsWith('P1 · #')));
});
