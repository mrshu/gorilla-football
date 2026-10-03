import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CHARACTERS } from '../src/data/characters.js';
import { createFootballer, animateFootballer } from '../src/ui/footballers.js';

class Vector {
  constructor(x = 0, y = 0, z = 0) { this.set(x, y, z); }
  set(x, y, z) { Object.assign(this, { x, y, z }); return this; }
  copy(v) { return this.set(v.x, v.y, v.z); }
  sub(v) { return this.set(this.x - v.x, this.y - v.y, this.z - v.z); }
  multiplyScalar(n) { return this.set(this.x * n, this.y * n, this.z * n); }
}
class Quaternion {
  constructor(x = 0, y = 0, z = 0, w = 1) { Object.assign(this, { x, y, z, w }); }
  copy(q) { Object.assign(this, q); return this; }
  invert() { this.x *= -1; this.y *= -1; this.z *= -1; return this; }
}
class Node {
  constructor(geometry, material) {
    Object.assign(this, { geometry, material, children: [], position: new Vector(), scale: new Vector(1, 1, 1), rotation: new Vector(), quaternion: new Quaternion(), visible: true });
    this.isMesh = Boolean(geometry);
  }
  add(child) { child.parent = this; this.children.push(child); }
  traverse(fn) { fn(this); for (const c of this.children) c.traverse(fn); }
  getObjectByName(name) { if (this.name === name) return this; for (const c of this.children) { const found = c.getObjectByName(name); if (found) return found; } }
  getWorldQuaternion(q) { return q.copy(this.quaternion); }
  getWorldPosition(v) { return v.copy(this.position); }
  updateMatrixWorld() {}
}
class Color { constructor(value) { this.value = value; } copy(c) { this.value = c.value; } }
class Material {
  constructor(options = {}) { Object.assign(this, options); this.color = new Color(options.color); }
  clone() { const result = new Material(this); result.color = new Color(this.color.value); return result; }
}
class Geometry { getAttribute(name) { return name === 'kitRest' ? {} : null; } }
class Mixer {
  constructor(root) { this.root = root; this.updates = []; }
  clipAction(clip) { return { time: 0, clip, play() {}, setEffectiveWeight(n) { this.weight = n; } }; }
  update(dt) { this.updates.push(dt); }
}
function clone(node) {
  const copy = new Node(node.geometry, node.material);
  copy.name = node.name;
  copy.isSkinnedMesh = node.isSkinnedMesh;
  copy.position.copy(node.position);
  copy.quaternion.copy(node.quaternion);
  for (const child of node.children) copy.add(clone(child));
  return copy;
}
const THREE = {
  Group: Node, Mesh: Node, Vector3: Vector, Quaternion, Color,
  MeshStandardMaterial: Material, MeshDepthMaterial: Material, RGBADepthPacking: 3201,
  SkeletonUtils: { clone }, AnimationMixer: Mixer,
};
for (const type of ['Sphere', 'Box', 'Cone', 'Cylinder', 'Torus']) THREE[`${type}Geometry`] = Geometry;
function kit() {
  const root = new Node();
  for (const [name, x, y] of [['Head', 0, 1.6], ['spine_03', 0, 1.31], ['lowerarm_l', .5, 1.45], ['lowerarm_r', -.5, 1.45], ['hand_l', .72, 1.45], ['hand_r', -.72, 1.45]]) {
    const bone = new Node(); bone.name = name; bone.position.set(x, y, 0); bone.quaternion.x = .0145; root.add(bone);
  }
  for (const name of ['body', 'eyes', 'eyebrows']) {
    const mesh = new Node(name === 'body' ? new Geometry() : { getAttribute() { return null; } }, new Material({ name, map: { isTexture: true } }));
    mesh.name = name; mesh.isSkinnedMesh = true; root.add(mesh);
  }
  return {
    THREE, templates: [root], bounds: { boot: .1, sock: .4, shortsHem: .6, waist: 1, collar: 1.5, sleeve: .4, headCutoff: 1.56 },
    sharedGeometries: new Set(root.children.filter(c => c.isMesh).map(c => c.geometry)),
    sharedMaterials: new Set(root.children.filter(c => c.isMesh).map(c => c.material)),
    clips: Object.fromEntries(['Walk_Loop', 'Jog_Fwd_Loop', 'Sprint_Loop', 'Idle_Loop', 'Slide_Loop'].map((name, i) => [name, { name, duration: 1 + i * .2 }])),
  };
}
function player(character = CHARACTERS[0], id = 'p1') {
  return { id, character, jersey: { primary: '#ffd35c', secondary: '#5fd4c7' }, vel: { x: 0, y: 0 }, sliding: 0 };
}
const features = {
  gorilla: ['gorilla-muzzle', 'gorilla-brow--1'],
  tortoise: ['tortoise-shell', 'tortoise-muzzle'],
  wizard: ['wizard-hat', 'wizard-beard'],
  rocket: ['rocket-helmet', 'rocket-visor'],
  penguin: ['penguin-beak', 'penguin-mask--1'],
  yeti: ['yeti-fur-head', 'yeti-forearm-fur--1'],
  plumber: ['plumber-cap', 'plumber-moustache--1'],
};

test('every chosen character replaces the generic human head with recognizable animated species pieces', () => {
  const shared = kit();
  for (const character of CHARACTERS) {
    const f = createFootballer(shared, player(character));
    assert.equal(f.characterId, character.id);
    assert.equal(f.characterRig.shape, character.look.shape);
    assert.equal(f.characterRig.head.parent.name, 'Head');
    assert.equal(f.characterRig.head.quaternion.x, -.0145, 'head cancels the imported bind tilt');
    assert.equal(f.root.getObjectByName('body').material.color.value, character.look.skin);
    assert.equal(f.root.getObjectByName('body').material.map, null, 'human skin texture must not tint the species');
    assert.equal(f.root.getObjectByName('eyes').visible, false);
    assert.equal(f.root.getObjectByName('eyebrows').visible, false);
    for (const name of features[character.id]) assert.ok(f.root.getObjectByName(name), `${character.id} needs ${name}`);
    for (const attachment of f.characterRig.attachments) attachment.traverse(part => {
      if (!part.isMesh) return;
      assert.ok(part.geometry instanceof Geometry);
      assert.ok(part.material instanceof Material);
      assert.equal(part.castShadow, true);
    });
    assert.equal(f.sharedGeometries, shared.sharedGeometries);
    assert.equal(f.sharedMaterials, shared.sharedMaterials);
  }
});

test('species proportions scale the complete skeleton with the head and keep all players near regulation size', () => {
  const models = Object.fromEntries(CHARACTERS.map(c => [c.id, createFootballer(kit(), player(c))]));
  assert.ok(models.gorilla.root.scale.y > models.plumber.root.scale.y);
  assert.ok(models.penguin.root.scale.y < models.plumber.root.scale.y);
  assert.ok(models.gorilla.root.scale.x > models.wizard.root.scale.x);
  for (const f of Object.values(models)) assert.ok(f.root.scale.y >= .95 && f.root.scale.y < 1.2);
  const tortoise = models.tortoise.root.getObjectByName('tortoise-shell');
  assert.equal(tortoise.parent.name, 'spine_03');
  assert.ok(tortoise.getObjectByName('shell-dome').position.z < 0, 'shell belongs behind the body facing +z');
  assert.ok(models.penguin.root.getObjectByName('penguin-beak').position.z > 0);
});

test('kit identity remains per player and the human head is clipped from colour and shadow passes', () => {
  const shared = kit();
  const first = createFootballer(shared, player());
  const secondPlayer = player(CHARACTERS[0], 'p2'); secondPlayer.jersey.primary = '#ab2134';
  const second = createFootballer(shared, secondPlayer);
  const body = first.root.getObjectByName('body'), other = second.root.getObjectByName('body');
  assert.notEqual(body.material, other.material);
  assert.equal(body.geometry, other.geometry);
  const shader = () => ({ uniforms: {}, vertexShader: '#include <common>\n#include <begin_vertex>', fragmentShader: '#include <common>\n#include <map_fragment>\n#include <clipping_planes_fragment>' });
  const a = shader(), b = shader(), depth = shader();
  body.material.onBeforeCompile(a); other.material.onBeforeCompile(b); body.customDepthMaterial.onBeforeCompile(depth);
  assert.equal(a.uniforms.kitShirt.value.value, '#ffd35c');
  assert.equal(b.uniforms.kitShirt.value.value, '#ab2134');
  assert.equal(a.uniforms.characterHeadCutoff.value, 1.56);
  assert.equal(depth.uniforms.characterHeadCutoff.value, 1.56);
  assert.match(a.fragmentShader, /vKitRest.y > characterHeadCutoff\) discard/);
  assert.match(depth.fragmentShader, /vCharacterHeight > characterHeadCutoff\) discard/);
  assert.equal(body.customDepthMaterial.skinning, true);
});

test('locomotion selects real walk/jog/sprint clips on a shared cycle and eases back to idle', () => {
  const p = player(), f = createFootballer(kit(), p);
  assert.equal(f.idle.weight, 1);
  for (const [speed, gait] of [[1.6, 0], [4.2, 1], [7.8, 2]]) {
    const cycle = f.cycle; p.vel.x = speed;
    for (let frame = 0; frame < 60; frame++) animateFootballer(f, p, 1 / 60);
    assert.notEqual(f.cycle, cycle);
    assert.ok(f.gaits[gait].action.weight > .95);
    for (const g of f.gaits) assert.ok(Math.abs(g.action.time / g.duration - f.cycle) < 1e-10);
  }
  p.vel.x = 0;
  for (let frame = 0; frame < 60; frame++) animateFootballer(f, p, 1 / 60);
  assert.ok(f.idle.weight > .95);
  assert.ok(f.gaits.every(g => g.action.weight < .001));
});

test('a rig loaded during a pause evaluates its idle pose once, then zero dt leaves it exactly frozen', () => {
  const f = createFootballer(kit(), player());
  assert.equal(f.idle.weight, 1);
  assert.ok(f.gaits.every(g => g.action.weight === 0));
  assert.deepEqual(f.mixer.updates, [0]);
  animateFootballer(f, player(), 0);
  assert.deepEqual(f.mixer.updates, [0], 'held frames must not evaluate or advance animation again');
  const bodyBytes = readFileSync(new URL('../public/models/footballer.glb', import.meta.url));
  const body = JSON.parse(bodyBytes.subarray(20, 20 + bodyBytes.readUInt32LE(12)).toString());
  const clipBytes = readFileSync(new URL('../public/models/anim-locomotion.glb', import.meta.url));
  const jsonLength = clipBytes.readUInt32LE(12);
  const clips = JSON.parse(clipBytes.subarray(20, 20 + jsonLength).toString());
  const idle = clips.animations.find(c => c.name === 'Idle_Loop');
  const channel = idle.channels.find(c => clips.nodes[c.target.node].name === 'upperarm_l' && c.target.path === 'rotation');
  const accessor = clips.accessors[idle.samplers[channel.sampler].output];
  const view = clips.bufferViews[accessor.bufferView];
  const start = 28 + jsonLength + (view.byteOffset || 0) + (accessor.byteOffset || 0);
  const pose = Array.from({ length: 4 }, (_, i) => clipBytes.readFloatLE(start + i * 4));
  const bind = body.nodes.find(n => n.name === 'upperarm_l').rotation;
  const alignment = Math.abs(pose.reduce((sum, n, i) => sum + n * bind[i], 0));
  assert.ok(alignment < .95, 'the real idle clip must lower the arm from its T-pose bind rotation');
});

test('held-frame animation freezes all gait/slide state and slides blend in and out of the moving rig', () => {
  const p = player(), f = createFootballer(kit(), p);
  p.vel.x = 7; p.sliding = 1;
  for (let frame = 0; frame < 30; frame++) animateFootballer(f, p, 1 / 60);
  assert.ok(f.slide.weight > .95);
  assert.ok(f.gaits.every(g => g.action.weight < .001));
  const frozen = JSON.stringify({ cycle: f.cycle, weights: f.weights, actions: f.gaits.map(g => g.action.time), slide: f.slide.time, updates: f.mixer.updates });
  for (const dt of [0, -1, NaN]) animateFootballer(f, p, dt);
  assert.equal(JSON.stringify({ cycle: f.cycle, weights: f.weights, actions: f.gaits.map(g => g.action.time), slide: f.slide.time, updates: f.mixer.updates }), frozen);
  p.sliding = 0;
  for (let frame = 0; frame < 60; frame++) animateFootballer(f, p, 1 / 60);
  assert.ok(f.slide.weight < .001);
  assert.ok(f.gaits.some(g => g.action.weight > .5));
});

test('shipped gait assets contain animated left/right arm and leg rotations rather than whole-body translation alone', () => {
  const bytes = readFileSync(new URL('../public/models/anim-locomotion.glb', import.meta.url));
  const jsonLength = bytes.readUInt32LE(12);
  const gltf = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString());
  const bin = bytes.subarray(28 + jsonLength);
  for (const clip of gltf.animations.filter(c => c.name !== 'Idle_Loop')) {
    for (const name of ['thigh_l', 'thigh_r', 'upperarm_l', 'upperarm_r']) {
      const channel = clip.channels.find(c => gltf.nodes[c.target.node].name === name && c.target.path === 'rotation');
      assert.ok(channel, `${clip.name} must animate ${name}`);
      const accessor = gltf.accessors[clip.samplers[channel.sampler].output];
      const view = gltf.bufferViews[accessor.bufferView];
      const start = (view.byteOffset || 0) + (accessor.byteOffset || 0);
      const stride = view.byteStride || 16;
      const initial = Array.from({ length: 4 }, (_, i) => bin.readFloatLE(start + i * 4));
      let changes = false;
      for (let key = 1; key < accessor.count; key++) {
        if (initial.some((v, i) => Math.abs(bin.readFloatLE(start + key * stride + i * 4) - v) > .03)) changes = true;
      }
      assert.ok(changes, `${clip.name} ${name} must have real joint rotation changes`);
    }
  }
});
