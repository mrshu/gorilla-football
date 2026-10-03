import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { CHARACTERS } from '../src/data/characters.js';
import { PlayerSpriteLibrary } from '../src/ui/player-sprites.js';
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
class Texture {
  constructor(image) { this.image = image; }
  dispose() { this.disposed = true; }
}
const THREE = {
  Vector2: Vector, Vector3: Vector, Group: Object3D, Mesh: Object3D,
  Color: class { constructor(value) { this.value = value; } },
  Texture, LinearFilter: 'linear', sRGBEncoding: 'srgb', DoubleSide: 'double',
};
for (const name of ['Plane', 'Ring', 'Circle', 'Sphere', 'Cylinder', 'Torus', 'Cone', 'Lathe', 'Box']) THREE[`${name}Geometry`] = Geometry;
for (const name of ['Shader', 'MeshBasic', 'MeshStandard']) THREE[`${name}Material`] = Material;

function fixture() {
  const renderer = Object.create(RendererWebGL.prototype);
  Object.assign(renderer, { THREE, scene: new Object3D(), playerViews: new Map(), spriteTextures: new Map(), spriteGeometry: new Geometry() });
  return renderer;
}
function player(character = CHARACTERS[0], id = 'p1', primary = '#ffd35c') {
  return { id, character, jersey: { primary, secondary: '#f5f4e9' }, vel: { x: 0, y: 0 }, facing: { x: 1, y: 0 }, sliding: 0 };
}
function pair(shape) {
  return Object.fromEntries(['idle', 'run'].map((pose) => [pose, new Texture({ width: 384, height: 576, shape, pose })]));
}
function loadingFixture(timeout = 1000) {
  const images = [];
  const library = new PlayerSpriteLibrary(THREE, {
    timeout,
    createImage: () => { const image = { width: 384, height: 576 }; images.push(image); return image; },
  });
  return { library, images };
}

test('every selected species renders its own artwork, regardless of generic humanoid availability', () => {
  const renderer = fixture();
  // A stale generic kit must never supersede the actual selection.
  renderer.footballers = {};
  for (const character of CHARACTERS) renderer.spriteTextures.set(character.look.shape, pair(character.look.shape));
  for (const character of CHARACTERS) {
    const p = player(character, character.id);
    const view = renderer.playerView(p);
    assert.equal(view.kind, 'sprite');
    assert.equal(view.material.uniforms.map.value.image.shape, character.look.shape);
    assert.equal(view.material.uniforms.primary.value.value, p.jersey.primary);
    assert.equal(view.material.uniforms.secondary.value.value, p.jersey.secondary);
    assert.equal(view.material.uniforms.accent.value.value, character.look.accent);
    assert.equal(view.material.uniforms.texelSize.value.x, 1 / 384);
    assert.equal(view.material.uniforms.texelSize.value.y, 1 / 576);
    assert.equal(view.shadow.material.color, 0x08101a);
    assert.ok(renderer.scene.children.includes(view.shadow));
  }
});

test('unloaded species keep their animated primitive rigs and upgrade independently', () => {
  const renderer = fixture();
  const p = player();
  const other = player(CHARACTERS[2], 'p2');
  const fallback = renderer.playerView(p);
  const otherFallback = renderer.playerView(other);
  assert.equal(fallback.kind, 'primitive');
  p.vel.x = 7;
  renderer.animate(fallback, p, 0.1);
  assert.notEqual(fallback.legs[0].hip.rotation.x, 0);
  assert.ok(fallback.group.children.some((child) => child.castShadow));
  renderer.spriteTextures.set(p.character.look.shape, pair(p.character.look.shape));
  const ready = renderer.playerView(p);
  assert.equal(ready.kind, 'sprite');
  assert.ok(!renderer.scene.children.includes(fallback.group));
  assert.equal(fallback.torso.geometry.disposed, true);
  assert.equal(renderer.playerView(other), otherFallback, 'another species should keep its fallback until ready');
  assert.equal(renderer.playerView(p), ready, 'ready sprites should remain cached');
});

test('same player id respects a changed character and jersey without disposing shared textures', () => {
  const renderer = fixture();
  for (const character of CHARACTERS) renderer.spriteTextures.set(character.look.shape, pair(character.look.shape));
  const p = player();
  const original = renderer.playerView(p);
  p.character = CHARACTERS[4];
  p.jersey.primary = '#5fd4c7';
  const changed = renderer.playerView(p);
  assert.notEqual(changed, original);
  assert.equal(changed.textures.idle.image.shape, 'wizard');
  assert.equal(changed.material.uniforms.primary.value.value, '#5fd4c7');
  assert.equal(original.material.disposed, true);
  assert.equal(renderer.spriteGeometry.disposed, undefined);
  assert.equal(original.textures.idle.disposed, undefined);
  assert.ok(!renderer.scene.children.includes(original.shadow));
});

test('idle, run and slide use crisp painted poses while retaining movement animation', () => {
  const renderer = fixture();
  const p = player();
  renderer.spriteTextures.set('gorilla', pair('gorilla'));
  const view = renderer.playerView(p);
  view.phase = 0;
  renderer.animate(view, p, 0.1);
  assert.equal(view.material.uniforms.map.value, view.textures.idle);
  p.vel.x = 6;
  renderer.animate(view, p, 0.1);
  assert.equal(view.material.uniforms.map.value, view.textures.run);
  assert.notEqual(view.plane.rotation.z, 0);
  assert.notEqual(view.bob, 0);
  p.vel.x = 0;
  p.sliding = 1;
  renderer.animate(view, p, 0.1);
  assert.equal(view.material.uniforms.map.value, view.textures.run);
  assert.equal(view.plane.scale.y, view.height * 0.58);
  assert.equal(view.bob, 0);
  p.sliding = 0;
  renderer.animate(view, p, 0.1);
  assert.equal(view.material.uniforms.map.value, view.textures.idle);
});

test('sprite requests are lazy, deduplicated and each species can finish independently', async () => {
  const { library, images } = loadingFixture();
  assert.equal(images.length, 0);
  const gorilla = library.load('gorilla');
  assert.equal(library.load('gorilla'), gorilla);
  assert.deepEqual(images.map((image) => image.src), ['public/assets/players/gorilla-idle.png', 'public/assets/players/gorilla-run.png']);
  const wizard = library.load('wizard');
  images[0].onload();
  images[1].onload();
  const ready = await gorilla;
  assert.equal(library.textures.get('gorilla'), ready);
  assert.equal(library.textures.has('wizard'), false);
  assert.equal(ready.idle.generateMipmaps, false);
  assert.equal(ready.idle.encoding, THREE.sRGBEncoding);
  images[2].onload();
  images[3].onload();
  await wizard;
  assert.equal(images.length, 4, 'unselected shapes must not be requested');
  assert.equal(await library.load('../unexpected'), null);
  assert.equal(images.length, 4);
  library.dispose();
});

test('only active roster species are requested, including a replacement selection on restart', async () => {
  const renderer = fixture();
  const { library, images } = loadingFixture();
  renderer.playerSprites = library;
  const p = player();
  renderer.loadPlayerSprites([p, player(CHARACTERS[0], 'other-team'), { ...player(CHARACTERS[3]), sentOff: true }]);
  assert.equal(images.length, 2);
  p.character = CHARACTERS[4];
  renderer.loadPlayerSprites([p]);
  assert.equal(images.length, 4);
  for (const image of images) image.onload();
  await Promise.all(library.requests.values());
  assert.deepEqual([...library.textures.keys()], ['gorilla', 'wizard']);
  library.dispose();
});

test('failed poses preserve character identity, release unused textures and do not retry every frame', async () => {
  const { library, images } = loadingFixture();
  const idleOnly = library.load('gorilla');
  images[0].onload();
  images[1].onerror();
  const ready = await idleOnly;
  assert.equal(ready.run, ready.idle);
  const failed = library.load('wizard');
  images[2].onerror();
  images[3].onload();
  assert.equal(await failed, null);
  assert.equal(library.textures.has('wizard'), false);
  assert.equal(library.load('wizard'), failed);
  assert.equal(images.length, 4);
  library.dispose();
  assert.equal(ready.idle.disposed, true);
});

test('hung and late image loads safely keep the primitive fallback', async () => {
  const { library } = loadingFixture(5);
  assert.equal(await library.load('gorilla'), null);
  assert.equal(library.textures.size, 0);
  const late = loadingFixture();
  const pending = late.library.load('wizard');
  late.library.dispose();
  for (const image of late.images) image.onload();
  assert.equal(await pending, null);
  assert.equal(late.library.textures.size, 0);
});

test('every species has compact transparent assets within the mobile download budget', () => {
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
  assert.ok(total < originals * 0.2, 'in-match assets should save at least 80% of the original download');
});
