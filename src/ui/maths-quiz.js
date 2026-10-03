// Maths quiz tokens and proportional geometry ported from football-puck-chaos.
// Questions are read-only; this view only reports answers and navigation.

import Maths from '../game/maths.js';

// Preview uses a fresh state and independent random source. It never reads
// saved learner profiles, updates mastery, or touches match randomness.
export function createMathsPreview(band, rand = Math.random) {
  if (!Number.isInteger(band) || band < 1 || band > Maths.MAX_BAND) {
    throw new RangeError('Select a starting age before previewing a question');
  }
  return Maths.make(band, Maths.newState(band), rand);
}

// Screen-reader equivalents also document every Maths.make token shape.
export function mathsTokenLabel(t) {
  switch (t.t) {
    case 'num': case 'op': case 'var': return String(t.v);
    case 'balls': return `${t.v} footballs`;
    case 'eq': return 'equals';
    case 'sep': return ',';
    case 'box': return 'unknown';
    case 'pct': return `${t.v} percent`;
    case 'pow': return `${t.v} to the power of ${t.e === '□' ? 'unknown' : t.e}`;
    case 'frac': return `${t.n} over ${t.d}`;
    case 'diag':
      switch (t.kind) {
        case 'angleLine': return `Straight line split into an angle of ${t.known} degrees and an unknown angle`;
        case 'angleTri': return `Triangle with angles ${t.a} degrees, ${t.b} degrees and an unknown angle`;
        case 'pythag': return `Right triangle with legs ${t.legA} and ${t.legB}; find its hypotenuse`;
        case 'areaComp': return `Find the area of a ${t.W} by ${t.H} rectangle with a ${t.w} by ${t.h} corner removed`;
      }
      break;
  }
  return '?';
}

var DIAG_FONT = '700 14px "Trebuchet MS", Verdana, sans-serif';
var LABEL_H = 14; // line box of a one-line label at the font above

// The unit vector pointing away from a vertex: opposite that vertex's
// interior bisector, i.e. away from the other two corners. A label placed
// along it always lands outside the shape, and — because the direction is
// more than 90° from both edges leaving the vertex — the nearest point of
// either edge is the vertex itself, so the distance pushed out IS the
// clearance from every stroke.
function outward(vx, vy, px, py, qx, qy) {
  var d1x = px - vx, d1y = py - vy, l1 = Math.sqrt(d1x * d1x + d1y * d1y) || 1;
  var d2x = qx - vx, d2y = qy - vy, l2 = Math.sqrt(d2x * d2x + d2y * d2y) || 1;
  var ox = -(d1x / l1 + d2x / l2), oy = -(d1y / l1 + d2y / l2);
  var ol = Math.sqrt(ox * ox + oy * oy) || 1;
  return { x: ox / ol, y: oy / ol };
}

// Pure geometry for the triangle diagram, kept out of the drawing code so
// the test suite can check the picture against its own labels.
//
// Base angles can each run up to 100°, so the shapes range from short and
// wide to nearly three times taller than the base is long. Solve the
// triangle on a unit base with the law of sines, then scale it UNIFORMLY:
// an independent x/y scale (what this used to do) draws angles that are not
// the labelled ones — 60/60/60 and 45/45/90 both came out as the same flat
// 39/39/102 scalene, which is exactly the sanity check a student is meant
// to be able to make on this question. Uniform scaling means the canvas
// cannot be a fixed box, so the size is computed here too: the drawing is
// laid out around the origin, its bounding box (strokes AND labels) is
// measured, and everything is shifted into a canvas that just fits.
// `measure(text)` returns a label's pixel width.
export function triangleGeometry(a, b, measure) {
  var MAX_W = 124, MAX_H = 112, MARGIN = 7, GAP = 11, HALF = 1; // HALF: half the stroke width
  var ar = a * Math.PI / 180, br = b * Math.PI / 180, cr = Math.PI - ar - br;
  // Apex of a triangle whose base runs (0,0)-(1,0), angle `a` at (0,0).
  var ux = Math.sin(br) * Math.cos(ar) / Math.sin(cr);
  var uy = Math.sin(br) * Math.sin(ar) / Math.sin(cr);
  var spanX = Math.max(1, ux) - Math.min(0, ux);
  var s = Math.min(MAX_W / spanX, MAX_H / uy);
  var pts = [{ x: 0, y: 0 }, { x: s, y: 0 }, { x: ux * s, y: -uy * s }];
  var texts = [a + '°', b + '°', '?'];
  var labels = [], i, j, k, dir, tw;
  var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  function span(x0, y0, x1, y1) {
    if (x0 < minX) { minX = x0; }
    if (y0 < minY) { minY = y0; }
    if (x1 > maxX) { maxX = x1; }
    if (y1 > maxY) { maxY = y1; }
  }
  for (i = 0; i < 3; i++) {
    j = (i + 1) % 3; k = (i + 2) % 3;
    dir = outward(pts[i].x, pts[i].y, pts[j].x, pts[j].y, pts[k].x, pts[k].y);
    tw = measure(texts[i]);
    // Offset per axis, so a label pushed sideways clears by GAP horizontally
    // and one pushed up or down clears by GAP vertically.
    labels.push({
      text: texts[i], w: tw,
      x: pts[i].x + dir.x * (GAP + tw / 2),
      y: pts[i].y + dir.y * (GAP + LABEL_H / 2)
    });
    span(pts[i].x - HALF, pts[i].y - HALF, pts[i].x + HALF, pts[i].y + HALF);
  }
  for (i = 0; i < labels.length; i++) {
    span(labels[i].x - labels[i].w / 2, labels[i].y - LABEL_H / 2,
         labels[i].x + labels[i].w / 2, labels[i].y + LABEL_H / 2);
  }
  var dx = MARGIN - minX, dy = MARGIN - minY;
  for (i = 0; i < 3; i++) { pts[i].x += dx; pts[i].y += dy; }
  for (i = 0; i < labels.length; i++) { labels[i].x += dx; labels[i].y += dy; }
  return {
    W: Math.ceil(maxX - minX) + MARGIN * 2,
    H: Math.ceil(maxY - minY) + MARGIN * 2,
    pts: pts, labels: labels
  };
}

// Pure geometry for the right-angled triangle: the real legs scaled into the
// drawable box by ONE factor, so the longer leg is drawn longer. Drawing
// both legs at a fixed size (what this used to do) put the "7" of 7/24/25 on
// the visually longest side half the time.
export function rightTriangleGeometry(legA, legB) {
  var BOX_W = 120, BOX_H = 72, LEFT = 30, BASE_Y = 92;
  var s = Math.min(BOX_W / legA, BOX_H / legB);
  var w = legA * s, h = legB * s;
  var x0 = LEFT + (BOX_W - w) / 2;
  return { x0: x0, y0: BASE_Y, x1: x0 + w, y1: BASE_Y - h, s: s };
}

// One diagram per geometry skill, drawn fresh each time. Labels are
// numerals and the degree sign only; the unknown is always '?'. Sized in
// CSS pixels and scaled by devicePixelRatio so lines stay crisp. Every
// canvas carries its own inline CSS size, because angleTri picks a size to
// suit its triangle and the others keep the standard 180x110 box.
function drawDiag(t) {
  var W = 180, H = 110, dpr = window.devicePixelRatio || 1, i, tri = null;
  var cv = document.createElement('canvas');
  var ctx = cv.getContext('2d');
  ctx.font = DIAG_FONT;

  if (t.kind === 'angleTri') {
    tri = triangleGeometry(t.a, t.b, function (s) { return ctx.measureText(s).width; });
    W = tri.W; H = tri.H;
  }

  cv.width = W * dpr; cv.height = H * dpr;
  cv.style.width = W + 'px'; cv.style.height = H + 'px';
  ctx.scale(dpr, dpr);
  ctx.strokeStyle = '#fff';
  ctx.fillStyle = '#fff';
  ctx.lineWidth = 2;
  ctx.font = DIAG_FONT;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  function line(x1, y1, x2, y2) {
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
  }

  if (t.kind === 'angleLine') {
    // The ray splits the straight (180°) line into a known wedge, between
    // the ray and the LEFT half of the baseline, and its complementary
    // unknown wedge, between the ray and the RIGHT half — the ray's own
    // angle from the +x axis is (180 - known), so the gap it leaves to
    // the left baseline is exactly `known` degrees wide. Each label sits
    // on its own wedge's bisector, pushed out along it until the label's
    // measured width clears both bounding lines — a fixed offset works
    // for a mid-sized wedge but crowds the ray when the wedge is as
    // narrow as this band's 25° floor allows.
    var cx = 90, cy = 90, rayLen = 78;
    var rad = (180 - t.known) * Math.PI / 180;
    var rx = cx + rayLen * Math.cos(rad), ry = cy - rayLen * Math.sin(rad);
    line(cx - rayLen, cy, cx + rayLen, cy);
    line(cx, cy, rx, ry);
    ctx.beginPath(); ctx.arc(cx, cy, 20, Math.PI, 0, false); ctx.stroke();
    var wedgeLabel = function (bisector, width, txt) {
      var half = Math.max(width / 2, 0.12);
      var tw = ctx.measureText(txt).width;
      // Base radius keeps the label inside its own wedge; pushing
      // further out by the label's own half-width plus a fixed margin
      // gives constant clearance from both bounding rays no matter how
      // steep the ray is. Dividing only by sin(half) (the old formula)
      // shrinks toward zero as the wedge narrows near a vertical ray,
      // which is exactly what let the glyph sit on the stroke.
      var base = Math.min(50, Math.max(20, 7 / Math.sin(half)));
      var r = Math.min(76, base + tw / 2 + 6);
      var x = Math.min(W - 12, Math.max(12, cx + r * Math.cos(bisector)));
      var y = Math.min(H - 9, Math.max(9, cy - r * Math.sin(bisector)));
      ctx.fillText(txt, x, y);
    };
    wedgeLabel((rad + Math.PI) / 2, Math.PI - rad, t.known + '°');
    wedgeLabel(rad / 2, rad, '?');
  } else if (t.kind === 'angleTri') {
    // Vertices and labels were all worked out (and the canvas sized around
    // them) by triGeom above; here they are only stroked and filled.
    line(tri.pts[0].x, tri.pts[0].y, tri.pts[1].x, tri.pts[1].y);
    line(tri.pts[1].x, tri.pts[1].y, tri.pts[2].x, tri.pts[2].y);
    line(tri.pts[2].x, tri.pts[2].y, tri.pts[0].x, tri.pts[0].y);
    for (i = 0; i < tri.labels.length; i++) {
      ctx.fillText(tri.labels[i].text, tri.labels[i].x, tri.labels[i].y);
    }
  } else if (t.kind === 'pythag') {
    var g = rightTriangleGeometry(t.legA, t.legB);
    var x0 = g.x0, y0 = g.y0, x1 = g.x1, y1 = g.y1;
    line(x0, y0, x1, y0); line(x1, y0, x1, y1); line(x0, y0, x1, y1);
    // Right-angle marker, shrunk on the thin triangles so it stays inside.
    var m = Math.max(5, Math.min(10, Math.min(x1 - x0, y0 - y1) * 0.3));
    line(x1 - m, y0, x1 - m, y0 - m); line(x1 - m, y0 - m, x1, y0 - m);
    ctx.fillText(String(t.legA), (x0 + x1) / 2, y0 + 9);
    ctx.fillText(String(t.legB), x1 + 12, (y0 + y1) / 2);
    // The '?' sits off the hypotenuse's midpoint, pushed along the outward
    // normal (away from the right-angle corner), so it clears the slope by
    // the same margin whatever the triple's shape.
    var hx = x1 - x0, hy = y1 - y0, hl = Math.sqrt(hx * hx + hy * hy) || 1;
    var nx = hy / hl, ny = -hx / hl; // unit normal, away from the corner at (x1, y0)
    var qw = ctx.measureText('?').width;
    ctx.fillText('?', (x0 + x1) / 2 + nx * (9 + qw / 2),
                      (y0 + y1) / 2 + ny * (9 + LABEL_H / 2));
  } else if (t.kind === 'areaComp') {
    // Outer W×H with the top-right w×h corner notched out, drawn to
    // scale. The brief's original path drew the left edge as the short
    // (H-h) segment and the right edge as the full H one, which is a
    // *different* shape (a base rect plus a tab) whose area is
    // W*(H-h)+w*h — equal to the scored W*H-w*h only when W happens to
    // be 2w. Tracing the outline the other way round the notch (full
    // height on the left, the short H-h edge on the right) draws the
    // shape the generator actually means and its area matches for
    // every W,H,w,h the generator can produce, verified by shoelace.
    var ox = 14, oy = 12, margin = 5;
    var sc = Math.min(150 / t.W, 84 / t.H);
    var pw = t.W * sc, ph = t.H * sc, nw = t.w * sc, nh = t.h * sc;
    var qm = ctx.measureText('?');
    var qw2 = qm.width;
    var qh = (typeof qm.actualBoundingBoxAscent === 'number')
      ? qm.actualBoundingBoxAscent + qm.actualBoundingBoxDescent
      : 11;
    // How much room the '?' would have to spare in each of the L's two
    // rectangles; the larger one wins below.
    var leftClear = Math.min((pw - nw) - (qw2 + margin * 2), ph - (qh + margin * 2));
    var botClear = Math.min(nw - (qw2 + margin * 2), (ph - nh) - (qh + margin * 2));
    ctx.beginPath();
    ctx.moveTo(ox, oy);
    ctx.lineTo(ox + pw - nw, oy);
    ctx.lineTo(ox + pw - nw, oy + nh);
    ctx.lineTo(ox + pw, oy + nh);
    ctx.lineTo(ox + pw, oy + ph);
    ctx.lineTo(ox, oy + ph);
    ctx.closePath(); ctx.stroke();
    ctx.fillText(String(t.W), ox + pw / 2, oy + ph + 8);
    ctx.fillText(String(t.H), ox - 8, oy + ph / 2);
    ctx.fillText(String(t.w), ox + pw - nw / 2, oy + nh - 8);
    ctx.fillText(String(t.h), ox + pw - nw + 8, oy + nh / 2);
    // The '?' goes in whichever of the L-shape's two rectangles — the
    // left column (pw-nw wide, full ph tall) or the bottom strip (nw
    // wide, ph-nh tall) — leaves more clearance around it; the
    // generator can make either one thin (H-h as small as 2 units, or
    // W-w as small as 3), so a fixed choice collides on the thin one.
    if (botClear >= leftClear) {
      ctx.fillText('?', ox + pw - nw / 2, oy + nh + (ph - nh) / 2);
    } else {
      ctx.fillText('?', ox + (pw - nw) / 2, oy + ph / 2);
    }
  }
  cv.setAttribute('aria-hidden', 'true');
  return cv;
}

// One display token -> one element. `√` arrives as an ordinary `op` token and
// renders inline ("√ 49 = box"), which reads correctly; it simply has no
// overbar. `pow` is the only token needing markup, and both its values come
// from the generator as integers.
export function renderMathsToken(t) {
  var e = document.createElement('span'), i, b;
  if (t.t === 'num') { e.textContent = t.v; }
  else if (t.t === 'balls') {
    e.className = 'mq-balls';
    for (i = 0; i < t.v; i++) {
      b = document.createElement('i');
      b.className = 'mq-ball';
      b.setAttribute('aria-hidden', 'true');
      e.appendChild(b);
    }
  }
  else if (t.t === 'op') { e.textContent = t.v; }
  else if (t.t === 'eq') { e.textContent = '='; }
  else if (t.t === 'sep') { e.textContent = ','; }
  else if (t.t === 'box') { e.className = 'mq-box'; }
  else if (t.t === 'pct') { e.textContent = t.v + '%'; }
  else if (t.t === 'pow') {
    e.appendChild(document.createTextNode(String(t.v)));
    var exponent = document.createElement('sup');
    exponent.textContent = String(t.e);
    e.appendChild(exponent);
  }
  else if (t.t === 'frac') {
    e.className = 'mq-frac';
    var n = document.createElement('span'), d = document.createElement('span');
    n.textContent = t.n;
    d.textContent = t.d;
    e.appendChild(n);
    e.appendChild(d);
  }
  else if (t.t === 'var') { e.className = 'mq-var'; e.textContent = t.v; }
  else if (t.t === 'diag') { e.className = 'mq-diag'; e.appendChild(drawDiag(t)); }
  else { e.textContent = '?'; }
  e.setAttribute('aria-label', mathsTokenLabel(t));
  return e;
}

let quizSequence = 0;

const element = (tag, className, text) => {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = String(text);
  return node;
};

// onAnswer reports learning/reward immediately. The game remains paused
// until onContinue, allowing the player to read the answer at their pace.
export function showMathsQuiz(root, question, {
  humanIndex = 0, flip = false, preview = false, previewLabel = '', onAnswer, onSkip, onContinue,
} = {}) {
  const previousFocus = document.activeElement;
  const id = `maths-quiz-${++quizSequence}`;
  const shownAt = performance.now();
  let active = true;
  let answered = false;
  const listeners = [];
  const listen = (node, type, listener) => {
    node.addEventListener(type, listener);
    listeners.push(() => node.removeEventListener(type, listener));
  };

  root.className = `overlay maths-quiz${flip ? ' maths-quiz-flip' : ''}${preview ? ' maths-preview' : ''}`;
  const panel = element('section', `mq-panel mq-p${humanIndex + 1}`);
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-labelledby', `${id}-title`);
  panel.setAttribute('aria-describedby', `${id}-lead`);
  const header = element('div', 'mq-header');
  const player = element('span', 'mq-player', `P${humanIndex + 1}`);
  player.id = `${id}-player`;
  player.setAttribute('aria-label', `Player ${humanIndex + 1}`);
  const heading = element('h2', 'mq-heading', preview ? 'Question preview' : 'Maths break');
  heading.id = `${id}-title`;
  panel.setAttribute('aria-labelledby', `${id}-player ${id}-title`);
  const identity = element('div', 'mq-identity');
  identity.append(player, heading);
  header.append(identity, element('span', 'mq-prize', preview ? (previewLabel || 'Preview') : 'Focused kick'));
  const lead = element('p', 'mq-lead', preview
    ? 'Try a sample question. Preview answers do not change your practice progress.'
    : 'Get it right for a more accurate next kick.');
  lead.id = `${id}-lead`;
  const prompt = element('div', 'mq-question');
  prompt.setAttribute('role', 'math');
  prompt.setAttribute('aria-label', question.render.map(mathsTokenLabel).join(' '));
  for (const token of question.render) prompt.append(renderMathsToken(token));

  const choices = element('div', 'mq-choices');
  choices.style.setProperty('--mq-columns', Math.min(3, question.choices.length));
  choices.setAttribute('role', 'group');
  choices.setAttribute('aria-label', 'Choose an answer');
  const feedback = element('p', 'mq-feedback');
  feedback.setAttribute('role', 'status');
  feedback.setAttribute('aria-live', 'polite');
  const footer = element('div', 'mq-footer');
  const pauseNote = element('span', 'mq-pause-note', preview ? 'Preview only' : 'Match paused');
  const skip = element('button', 'mq-skip', preview ? 'Back to setup' : 'Skip · keep playing');
  skip.type = 'button';
  const proceed = element('button', 'mq-continue', 'Continue');
  proceed.type = 'button';
  proceed.hidden = true;
  footer.append(pauseNote, skip, proceed);

  function cleanup() {
    if (!active) return;
    active = false;
    for (const remove of listeners) remove();
    if (root.contains(panel)) {
      root.replaceChildren();
      root.hidden = true;
      root.className = 'overlay';
    }
    if (previousFocus?.isConnected && !panel.contains(previousFocus)) previousFocus.focus();
  }

  function skipQuestion() {
    if (!active || (answered && !preview)) return;
    cleanup();
    if (answered) onContinue?.();
    else onSkip?.();
  }

  const answerButtons = question.choices.map((value) => {
    const button = element('button', 'mq-answer', value);
    button.type = 'button';
    listen(button, 'click', () => {
      if (!active || answered) return;
      answered = true;
      const correct = value === question.answer;
      const elapsedMs = Math.max(0, Math.round(performance.now() - shownAt));
      answerButtons.forEach(({ button: other, value: otherValue }) => {
        other.disabled = true;
        if (otherValue === question.answer) other.classList.add('mq-correct');
      });
      if (!correct) button.classList.add('mq-wrong');
      feedback.textContent = preview
        ? (correct ? 'Correct! Your practice progress is unchanged.' : `The correct answer is ${question.answer}. Your practice progress is unchanged.`)
        : (correct ? 'Correct! Focused kick earned for your next pass or shot.' : `The correct answer is ${question.answer}. Keep playing and try the next one.`);
      feedback.classList.toggle('mq-success', correct);
      panel.classList.add('mq-answered');
      pauseNote.hidden = true;
      skip.hidden = true;
      proceed.hidden = false;
      proceed.textContent = preview ? 'Back to setup' : (correct ? 'Continue · Focused kick ready' : 'Continue');
      if (!preview) onAnswer?.(correct, elapsedMs);
      if (active) proceed.focus();
    });
    choices.append(button);
    return { button, value };
  });

  listen(skip, 'click', skipQuestion);
  listen(proceed, 'click', () => {
    if (!active || !answered) return;
    cleanup();
    onContinue?.();
  });
  listen(panel, 'keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      skipQuestion();
    } else if (event.key === 'Tab') {
      const available = [...panel.querySelectorAll('button')].filter((button) => !button.disabled && !button.hidden);
      const first = available[0];
      const last = available[available.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  });

  panel.append(header, lead, prompt, choices, feedback, footer);
  root.replaceChildren(panel);
  root.hidden = false;
  answerButtons[0]?.button.focus();
  return { cleanup, cancel: cleanup };
}
