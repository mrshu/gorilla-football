import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InputManager } from '../src/ui/input.js';

function input() {
  const manager = Object.create(InputManager.prototype);
  Object.assign(manager, { keys: new Set(), pressed: {}, justPressed: {}, pauseRequested: false });
  return manager;
}

function event(key, { control = null, editable = false, prevented = false } = {}) {
  return {
    key, defaultPrevented: prevented,
    target: { isContentEditable: editable, closest: () => control },
    preventDefault() { this.defaultPrevented = true; },
  };
}

test('native maths age selection and quiz buttons retain keyboard browser defaults', () => {
  for (const control of ['select', 'button', 'input', 'textarea', 'a']) {
    for (const key of ['ArrowDown', 'ArrowUp', ' ', 'l', 'p']) {
      const manager = input();
      const e = event(key, { control });
      manager.onKey(e, true);
      assert.equal(e.defaultPrevented, false, `${control} ${key} default must survive`);
      assert.equal(manager.keys.size, 0);
      assert.deepEqual(manager.pressed, {});
      assert.deepEqual(manager.justPressed, {});
      assert.equal(manager.pauseRequested, false);
      manager.onKey(e, false);
      assert.equal(e.defaultPrevented, false, `${control} ${key} keyup default must survive`);
    }
  }
});

test('unhandled Escape still pauses from decision buttons while handled maths Escape does not', () => {
  const manager = input();
  const decisionEscape = event('Escape', { control: 'button' });
  manager.onKey(decisionEscape, true);
  assert.equal(manager.takePause(), true);
  assert.equal(decisionEscape.defaultPrevented, false);
  manager.onKey(event('Escape', { control: 'button', prevented: true }), true);
  assert.equal(manager.takePause(), false);
});

test('contenteditable and already handled UI events cannot schedule gameplay actions', () => {
  const manager = input();
  manager.onKey(event('j', { editable: true }), true);
  manager.onKey(event('k', { prevented: true }), true);
  assert.deepEqual(manager.justPressed, {});
  assert.equal(manager.keys.size, 0);
});

test('game keyboard movement, actions and pause still work on canvas or body', () => {
  for (const surface of ['canvas', 'body']) {
    const manager = input();
    manager.onKey(event('w'), true);
    manager.onKey(event('d'), true);
    assert.deepEqual(manager.keyboardVector(0), { x: 1, y: -1 }, surface);
    const arrow = event('ArrowLeft');
    manager.onKey(arrow, true);
    assert.equal(arrow.defaultPrevented, true, 'gameplay arrows suppress page scrolling');
    assert.deepEqual(manager.keyboardVector(1), { x: -1, y: 0 });
    manager.onKey(event('l'), true);
    manager.onKey(event('2'), true);
    assert.deepEqual(manager.justPressed, { '0:special': true, '1:shoot': true });
    manager.onKey(event('Escape'), true);
    assert.equal(manager.pauseRequested, true);
  }
});

test('keyup in a UI control releases gameplay keys held before focus changed', () => {
  const manager = input();
  manager.onKey(event('w'), true);
  manager.onKey(event('j'), true);
  const w = event('w', { control: 'select' });
  const j = event('j', { control: 'button' });
  manager.onKey(w, false);
  manager.onKey(j, false);
  assert.deepEqual(manager.keyboardVector(0), { x: 0, y: 0 });
  assert.deepEqual(manager.pressed, {});
  assert.equal(w.defaultPrevented, false);
  assert.equal(j.defaultPrevented, false);
});
