import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { CHARACTERS } from '../src/data/characters.js';
import { RendererWebGL } from '../src/ui/renderer_webgl.js';

class Vector {
  constructor(x = 0, y = 0, z = 0) { this.set(x, y, z); }
  set(x, y, z) { Object.assign(this, { x, y, z }); return this; }
  setScalar(n) { return this.set(n, n, n); }
  copy(v) { return this.set(v.x, v.y, v.z); }
  add(v) { return this.set(this.x + v.x, this.y + v.y, this.z + v.z); }
  subVectors(a, b) { return this.set(a.x - b.x, a.y - b.y, a.z - b.z); }
  multiplyScalar(n) { return this.set(this.x * n, this.y * n, this.z * n); }
  length() { return Math.hypot(this.x, this.y, this.z); }
  normalize() { return this.multiplyScalar(1 / this.length()); }
}
class Object3D {
  constructor(geometry, material) {
    Object.assign(this, { geometry, material, children: [], position: new Vector(), scale: new Vector(1, 1, 1), rotation: new Vector() });
    this.quaternion = { setFromUnitVectors() {} };
  }
  add(...children) { this.children.push(...children); }
  remove(child) { this.children = this.children.filter((item) => item !== child); }
  traverse(visitor) { visitor(this); for (const child of this.children) child.traverse(visitor); }
}
class Geometry {
  computeVertexNormals() {}
  dispose() { this.disposed = true; }
}
class Material {
  constructor(options) { Object.assign(this, options); }
  dispose() { this.disposed = true; }
}
const THREE = {
  Vector2: Vector, Vector3: Vector, Group: Object3D, Mesh: Object3D,
  Color: class { constructor(value) { this.value = value; } },
  DoubleSide: 'double',
};
for (const name of ['Plane', 'Ring', 'Circle', 'Sphere', 'Cylinder', 'Torus', 'Cone', 'Lathe', 'Box']) THREE[`${name}Geometry`] = Geometry;
for (const name of ['Shader', 'MeshBasic', 'MeshStandard']) THREE[`${name}Material`] = Material;

function fixture() {
  const renderer = Object.create(RendererWebGL.prototype);
  Object.assign(renderer, { THREE, scene: new Object3D(), playerViews: new Map(), footballers: null });
  return renderer;
}
function player(character = CHARACTERS[0], id = 'p1', primary = '#ffd35c') {
  return { id, character, jersey: { primary, secondary: '#f5f4e9' }, vel: { x: 0, y: 0 }, facing: { x: 1, y: 0 }, sliding: 0 };
}
test('players awaiting models have articulated arms and legs rather than static cutouts', () => {
  const renderer = fixture();
  for (const character of CHARACTERS) {
    const p = player(character, character.id);
    const view = renderer.playerView(p);
    assert.equal(view.kind, 'primitive');
    view.phase = 0;
    p.vel.x = 7;
    renderer.animate(view, p, 0.1);
    assert.ok(Math.abs(view.legs[0].hip.rotation.x) > 0.3, 'a running leg needs visible swing');
    assert.equal(view.legs[0].hip.rotation.x, -view.legs[1].hip.rotation.x, 'legs stride in opposition');
    assert.equal(view.arms[0].rotation.x, -view.arms[1].rotation.x, 'arms counter-swing');
    const first = view.legs[0].hip.rotation.x;
    renderer.animate(view, p, 0.3);
    assert.notEqual(view.legs[0].hip.rotation.x, first, 'limb pose changes while running');
    const pose = [view.phase, view.legs[0].hip.rotation.x, view.arms[0].rotation.x];
    renderer.animate(view, p, 0);
    assert.deepEqual([view.phase, view.legs[0].hip.rotation.x, view.arms[0].rotation.x], pose, 'drawing freezes the visible gait');
  }
});

test('loaded character rigs replace primitives independently and respect same-id character and kit changes', () => {
  const renderer = fixture();
  const p = player();
  const fallback = renderer.playerView(p);
  assert.equal(fallback.kind, 'primitive');
  renderer.footballers = {};
  renderer.characterPlayerView = (selected, signature) => {
    const view = { kind: 'character', characterId: selected.character.id, kit: selected.jersey.primary, group: new Object3D(), signature };
    renderer.scene.add(view.group);
    renderer.playerViews.set(selected.id, view);
    return view;
  };
  renderer.freezePlayerViews = true;
  assert.equal(renderer.playerView(p), fallback, 'a download cannot replace a held kick pose');
  renderer.freezePlayerViews = false;
  for (const character of CHARACTERS) {
    p.character = character;
    const view = renderer.playerView(p);
    assert.equal(view.kind, 'character');
    assert.equal(view.characterId, character.id);
    assert.equal(renderer.playerView(p), view, 'unchanged views remain cached');
  }
  assert.ok(!renderer.scene.children.includes(fallback.group));
  assert.equal(fallback.torso.geometry.disposed, true);
  const previous = renderer.playerView(p);
  p.jersey.primary = '#5fd4c7';
  const changed = renderer.playerView(p);
  assert.notEqual(changed, previous);
  assert.equal(changed.kit, '#5fd4c7');
});

test('removing a rig cleans its mixer and owned geometry without disposing the shared body', () => {
  const renderer = fixture();
  const shared = new Geometry(), owned = new Geometry();
  const material = new Material(), sharedMaterial = new Material(), depth = new Material();
  const root = new Object3D();
  root.add(new Object3D(shared, material), new Object3D(owned, new Material()));
  const hiddenEyes = new Object3D(shared, sharedMaterial);
  hiddenEyes.customDepthMaterial = depth;
  root.add(hiddenEyes);
  const group = new Object3D(); group.add(root); renderer.scene.add(group);
  let stopped = false, uncached;
  renderer.removePlayerView({group, footballer: {
    root, sharedGeometries: new Set([shared]), sharedMaterials: new Set([sharedMaterial]), mixer: {
      stopAllAction: () => { stopped = true; }, uncacheRoot: (value) => { uncached = value; },
    },
  }});
  assert.equal(stopped, true);
  assert.equal(uncached, root);
  assert.equal(shared.disposed, undefined);
  assert.equal(owned.disposed, true);
  assert.equal(material.disposed, true);
  assert.equal(sharedMaterial.disposed, undefined);
  assert.equal(depth.disposed, true);
  assert.ok(!renderer.scene.children.includes(group));
});

test('character portraits remain compact transparent assets', () => {
  let total = 0, originals = 0;
  for (const character of CHARACTERS) {
    for (const pose of ['idle', 'run']) {
      const file = new URL(`../public/assets/players/${character.look.shape}-${pose}.png`, import.meta.url);
      const png = readFileSync(file);
      assert.equal(png.subarray(1, 4).toString(), 'PNG');
      const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
      assert.ok(width <= 512 && height <= 768);
      assert.equal(width / height, 2 / 3);
      assert.equal(png[25], 6, 'RGBA must retain the transparent cutout');
      total += png.length;
      originals += statSync(new URL(`../public/assets/player-sprite-${character.look.shape}${pose === 'run' ? '-run' : ''}.png`, import.meta.url)).size;
    }
  }
  assert.ok(total < 3 * 1024 * 1024, `sprite library ${total} bytes must remain below 3 MiB`);
  assert.ok(total < originals * 0.2, 'derived artwork should save at least 80% of the original download');
});
