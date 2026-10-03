import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMathsPreview, showMathsQuiz, mathsTokenLabel, triangleGeometry, rightTriangleGeometry } from '../src/ui/maths-quiz.js';
import { mathsStartingAgeLabel } from '../src/ui/screens.js';

test('maths token descriptions retain fractions, powers, unknowns and geometry dimensions', () => {
  assert.equal(mathsTokenLabel({ t: 'frac', n: 3, d: 4 }), '3 over 4');
  assert.equal(mathsTokenLabel({ t: 'pow', v: 2, e: '□' }), '2 to the power of unknown');
  assert.equal(mathsTokenLabel({ t: 'balls', v: 5 }), '5 footballs');
  assert.equal(mathsTokenLabel({ t: 'pct', v: 25 }), '25 percent');
  assert.equal(mathsTokenLabel({ t: 'diag', kind: 'areaComp', W: 12, H: 8, w: 4, h: 3 }),
    'Find the area of a 12 by 8 rectangle with a 4 by 3 corner removed');
  assert.match(mathsTokenLabel({ t: 'diag', kind: 'angleLine', known: 35 }), /35 degrees/);
  assert.match(mathsTokenLabel({ t: 'diag', kind: 'angleTri', a: 60, b: 50 }), /60 degrees, 50 degrees/);
  assert.match(mathsTokenLabel({ t: 'diag', kind: 'pythag', legA: 5, legB: 12 }), /legs 5 and 12/);
});

test('ported triangles preserve actual angles and keep labels inside their canvas', () => {
  for (const [a, b] of [[60, 60], [45, 45], [100, 35], [35, 100]]) {
    const g = triangleGeometry(a, b, (text) => text.length * 8);
    const [left, right, apex] = g.pts;
    const baseAngle = Math.atan2(left.y - apex.y, apex.x - left.x) * 180 / Math.PI;
    assert.ok(Math.abs(baseAngle - a) < 1e-8);
    assert.equal(left.y, right.y);
    for (const label of g.labels) {
      assert.ok(label.x - label.w / 2 >= 0 && label.x + label.w / 2 <= g.W);
      assert.ok(label.y - 7 >= 0 && label.y + 7 <= g.H);
    }
  }
});

test('right-triangle diagrams preserve unequal leg proportions', () => {
  for (const [legA, legB] of [[3, 4], [7, 24], [24, 7]]) {
    const g = rightTriangleGeometry(legA, legB);
    assert.ok(Math.abs((g.x1 - g.x0) / (g.y0 - g.y1) - legA / legB) < 1e-8);
  }
});

test('previews generate real questions at every selected band without accessing stored profiles', () => {
  for (let band = 1; band <= 11; band++) {
    const question = createMathsPreview(band, () => 0.42);
    assert.equal(question.band, band);
    assert.ok(question.render.length > 0);
    assert.ok(question.choices.includes(question.answer));
    assert.ok(question.skill);
  }
  for (const band of [0, -1, 12, 2.5, '5']) assert.throws(() => createMathsPreview(band), RangeError);
  assert.equal(mathsStartingAgeLabel(0), 'Off');
  assert.equal(mathsStartingAgeLabel(1), 'Age 5');
  assert.equal(mathsStartingAgeLabel(10), 'Ages 14–15');
  assert.equal(mathsStartingAgeLabel(11), 'Age 16+');
});

// A small DOM stand-in exercises callback and focus lifecycles without a
// browser dependency. Diagram rendering has separate geometry checks above.
function quizDocument() {
  const doc = { activeElement: null };
  class Element extends EventTarget {
    constructor(tag) {
      super();
      this.tagName = tag;
      this.children = [];
      this.attributes = {};
      this.style = { setProperty() {} };
      this.className = '';
      this.parentNode = null;
      this._text = '';
      this.hidden = false;
      this.disabled = false;
    }
    get isConnected() { return this === doc.root || Boolean(this.parentNode?.isConnected); }
    set textContent(text) { this._text = String(text); }
    get textContent() { return this._text + this.children.map((node) => node.textContent).join(''); }
    get classList() {
      const set = (name, present) => {
        const classes = new Set(this.className.split(' ').filter(Boolean));
        if (present) classes.add(name); else classes.delete(name);
        this.className = [...classes].join(' ');
      };
      return { add: (name) => set(name, true), toggle: set };
    }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    getAttribute(name) { return this.attributes[name]; }
    append(...nodes) {
      for (const node of nodes) {
        node.parentNode = this;
        this.children.push(node);
      }
    }
    appendChild(node) { this.append(node); return node; }
    replaceChildren(...nodes) {
      this.children.forEach((node) => { node.parentNode = null; });
      this.children = [];
      this.append(...nodes);
    }
    contains(node) { return this === node || this.children.some((child) => child.contains(node)); }
    querySelectorAll(tag) { return this.children.flatMap((node) => [...(node.tagName === tag ? [node] : []), ...node.querySelectorAll(tag)]); }
    focus() { doc.activeElement = this; }
    click() { if (!this.disabled) this.dispatchEvent(new Event('click')); }
  }
  doc.createElement = (tag) => new Element(tag);
  doc.createTextNode = (text) => {
    const node = new Element('#text');
    node.textContent = text;
    return node;
  };
  doc.root = new Element('div');
  return doc;
}

function withQuizDocument(run) {
  const prior = globalThis.document;
  const doc = quizDocument();
  globalThis.document = doc;
  try { run(doc); } finally {
    if (prior === undefined) delete globalThis.document;
    else globalThis.document = prior;
  }
}

const question = { render: [{ t: 'num', v: 2 }, { t: 'eq' }, { t: 'box' }], choices: [1, 2], answer: 2 };

test('preview answers retain feedback and never dispatch learning or reward callbacks', () => {
  for (const answerIndex of [0, 1]) withQuizDocument((doc) => {
    let answered = 0;
    let returned = 0;
    showMathsQuiz(doc.root, question, {
      preview: true, previewLabel: 'Age 5',
      onAnswer: () => answered++, onContinue: () => returned++,
    });
    assert.match(doc.root.textContent, /Question preview/);
    assert.doesNotMatch(doc.root.textContent, /Focused kick|Match paused/);
    const buttons = doc.root.querySelectorAll('button');
    buttons[answerIndex].click();
    assert.equal(answered, 0);
    assert.equal(returned, 0);
    assert.match(doc.root.textContent, /progress is unchanged/);
    if (answerIndex === 0) assert.match(doc.root.textContent, /correct answer is 2/);
    assert.equal(doc.activeElement, buttons[3]);
    assert.equal(buttons[3].textContent, 'Back to setup');
    buttons[3].click();
    buttons[3].click();
    assert.equal(returned, 1);
    assert.equal(doc.root.children.length, 0);
  });
});

test('Escape exits a preview before or after answering and cleanup prevents later callbacks', () => {
  for (const answerFirst of [false, true]) withQuizDocument((doc) => {
    let skipped = 0;
    let continued = 0;
    const handle = showMathsQuiz(doc.root, question, {
      preview: true, onSkip: () => skipped++, onContinue: () => continued++,
    });
    const panel = doc.root.children[0];
    const buttons = panel.querySelectorAll('button');
    if (answerFirst) buttons[1].click();
    const escape = new Event('keydown', { cancelable: true });
    Object.defineProperty(escape, 'key', { value: 'Escape' });
    panel.dispatchEvent(escape);
    assert.equal(escape.defaultPrevented, true);
    assert.equal(skipped, answerFirst ? 0 : 1);
    assert.equal(continued, answerFirst ? 1 : 0);
    handle.cleanup();
    buttons[2].click();
    assert.equal(skipped + continued, 1);
  });
});

test('live quiz keeps reward callbacks and waits for explicit Continue', () => withQuizDocument((doc) => {
  let answered = 0;
  let continued = 0;
  showMathsQuiz(doc.root, question, {
    onAnswer: (correct, elapsedMs) => { assert.equal(correct, true); assert.ok(elapsedMs >= 0); answered++; },
    onContinue: () => continued++,
  });
  const buttons = doc.root.querySelectorAll('button');
  buttons[1].click();
  assert.equal(answered, 1);
  assert.equal(continued, 0);
  assert.match(doc.root.textContent, /Focused kick earned/);
  buttons[3].click();
  assert.equal(continued, 1);
}));
