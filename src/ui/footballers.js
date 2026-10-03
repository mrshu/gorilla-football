// Skinned, animated footballers built from the CC0 Quaternius base character
// and animation library (public/models/CREDITS.md).
//
// One body mesh serves every player. The kit is painted in the shader from
// where each vertex sits in the bind pose (a T-pose), so the jersey, shorts,
// socks and boots bend with the skeleton and take any team's colours without
// a texture per kit. Species heads/accessories, skin and proportions follow
// the selected character, while every limb uses the real gait skeleton.

import { loadScript } from './three-loader.js';
import { attachCharacterRig } from './character-rig.js';

const MODELS = 'public/models/';
const ADDONS = ['public/vendor/three/GLTFLoader.js', 'public/vendor/three/SkeletonUtils.js'];

// Locomotion clips and the ground speed (m/s) at which each one's feet stop
// sliding. Between two entries the clips are blended on a shared cycle.
const GAITS = [
  { key: 'walk', clip: 'Walk_Loop', speed: 1.6 },
  { key: 'jog', clip: 'Jog_Fwd_Loop', speed: 4.2 },
  { key: 'sprint', clip: 'Sprint_Loop', speed: 7.8 },
];
const IDLE_BELOW = 0.35;
const SKIN_MATERIAL = 'MI_Superhero_Male';

export async function loadFootballers(THREE) {
  for (const src of ADDONS) {
    if (!(await loadScript(src))) throw new Error(`could not load ${src}`);
  }
  if (!THREE.GLTFLoader || !THREE.SkeletonUtils) throw new Error('three.js addons did not register');
  const loader = new THREE.GLTFLoader();
  const load = (name) => new Promise((resolve, reject) => loader.load(MODELS + name + '.glb', resolve, undefined, reject));
  const [body, locomotion, slide] = await Promise.all([
    load('footballer'),
    load('anim-locomotion'),
    load('anim-slide'),
  ]);

  const clips = {};
  for (const c of [...locomotion.animations, ...slide.animations]) clips[c.name] = c;
  for (const g of GAITS) if (!clips[g.clip]) throw new Error(`missing clip ${g.clip}`);
  if (!clips.Idle_Loop || !clips.Slide_Loop) throw new Error('missing idle or slide clip');

  // The body file also carries the eyes and eyebrows; the kit goes on the skin.
  const bodyMesh = findSkinned(body.scene).find((m) => m.material.name === SKIN_MATERIAL);
  if (!bodyMesh) throw new Error('footballer has no skin mesh');
  // This renderer leaves output in linear space (see RendererWebGL), so the
  // textures pass straight through rather than being decoded from sRGB.
  body.scene.traverse((o) => {
    if (!o.isMesh) return;
    for (const m of [].concat(o.material)) {
      if (m.map) { m.map.encoding = THREE.LinearEncoding; m.map.needsUpdate = true; }
    }
  });
  body.scene.updateMatrixWorld(true);
  const bounds = kitBounds(body.scene);
  addRestPositions(THREE, bodyMesh);

  const sharedGeometries = new Set(), sharedMaterials = new Set();
  body.scene.traverse((o) => {
    if (!o.isMesh) return;
    sharedGeometries.add(o.geometry);
    for (const material of [].concat(o.material)) sharedMaterials.add(material);
  });
  const textures = new Set();
  for (const material of sharedMaterials) {
    for (const value of Object.values(material)) if (value?.isTexture) textures.add(value);
  }
  let disposed = false;
  return {
    THREE, templates: [body.scene], clips, bounds, sharedGeometries, sharedMaterials,
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const geometry of sharedGeometries) geometry.dispose();
      for (const material of sharedMaterials) material.dispose();
      for (const texture of textures) texture.dispose();
    },
  };
}

// A player's model. `p` supplies the kit, character and a stable id to vary
// the look by; the returned view is driven by animateFootballer.
export function createFootballer(kit, p) {
  const { THREE } = kit;
  const seed = hashId(p.id);
  const root = THREE.SkeletonUtils.clone(kit.templates[seed % kit.templates.length]);
  const skin = new THREE.Color(p.character.look.skin);
  const jersey = p.jersey;
  root.traverse((o) => {
    if (!o.isSkinnedMesh) return;
    o.castShadow = true;
    // Animated limbs leave the bind-pose bounds; culling on them pops players.
    o.frustumCulled = false;
    if (o.geometry.getAttribute('kitRest')) {
      o.material = kitMaterial(THREE, o.material, kit.bounds, jersey, skin);
      o.customDepthMaterial = characterDepthMaterial(THREE, kit.bounds.headCutoff);
    } else o.visible = false; // Original human eyes/brows belong to the hidden head.
  });
  const characterRig = attachCharacterRig(THREE, root, p.character);
  const mixer = new THREE.AnimationMixer(root);
  const action = (name) => {
    const a = mixer.clipAction(kit.clips[name]);
    a.play();
    a.setEffectiveWeight(0);
    return a;
  };
  const gaits = GAITS.map((g) => ({ ...g, action: action(g.clip), duration: kit.clips[g.clip].duration }));
  // Gait clips are posed from a shared cycle each frame, not by the mixer clock.
  for (const g of gaits) g.action.timeScale = 0;
  const idle = action('Idle_Loop');
  idle.time = (seed % 100) / 100 * kit.clips.Idle_Loop.duration;
  const slide = action('Slide_Loop');
  idle.setEffectiveWeight(1);
  // Evaluate idle once even if the model arrives while aiming or paused;
  // zero animationDt must preserve this pose rather than the bind T-pose.
  mixer.update(0);
  return {
    root,
    mixer,
    gaits,
    idle,
    slide,
    cycle: (seed % 97) / 97,
    weights: { idle: 1, slide: 0, gaits: gaits.map(() => 0) },
    heading: null,
    characterId: p.character.id,
    characterRig,
    sharedGeometries: kit.sharedGeometries,
    sharedMaterials: kit.sharedMaterials,
  };
}

// Blend idle -> walk -> jog -> sprint by ground speed on one shared foot
// cycle, so the feet stay planted through the transitions, and lay the
// player out for a slide tackle.
export function animateFootballer(f, p, dt) {
  if (!(dt > 0)) return;
  const speed = Math.hypot(p.vel.x, p.vel.y);
  const sliding = p.sliding > 0;
  const target = gaitWeights(f.gaits, speed);
  const moving = speed > IDLE_BELOW ? 1 : 0;
  const k = 1 - Math.exp(-12 * dt);
  const w = f.weights;
  const slideTarget = sliding ? 1 : 0;
  w.slide += (slideTarget - w.slide) * (sliding ? 1 - Math.exp(-30 * dt) : k);
  const upright = 1 - w.slide;
  w.idle += ((1 - moving) * upright - w.idle) * k;
  for (let i = 0; i < f.gaits.length; i++) w.gaits[i] += (target[i] * moving * upright - w.gaits[i]) * k;

  // Each gait completes one stride cycle per `duration` at its own speed; the
  // shared cycle advances by the blend of those rates scaled to actual speed.
  let rate = 0;
  let total = 0;
  for (let i = 0; i < f.gaits.length; i++) {
    const g = f.gaits[i];
    rate += target[i] * (Math.min(1.6, Math.max(0.55, speed / g.speed)) / g.duration);
    total += target[i];
  }
  if (total > 0) f.cycle = (f.cycle + (rate / total) * dt) % 1;
  for (let i = 0; i < f.gaits.length; i++) {
    const g = f.gaits[i];
    g.action.time = f.cycle * g.duration;
    g.action.setEffectiveWeight(w.gaits[i]);
  }
  f.idle.setEffectiveWeight(w.idle);
  if (sliding && !f.wasSliding) f.slide.time = 0;
  f.wasSliding = sliding;
  f.slide.setEffectiveWeight(w.slide);
  f.mixer.update(dt);
}

function gaitWeights(gaits, speed) {
  const out = gaits.map(() => 0);
  if (speed <= gaits[0].speed) out[0] = 1;
  else if (speed >= gaits[gaits.length - 1].speed) out[gaits.length - 1] = 1;
  else {
    for (let i = 0; i < gaits.length - 1; i++) {
      const a = gaits[i].speed;
      const b = gaits[i + 1].speed;
      if (speed >= a && speed <= b) {
        const t = (speed - a) / (b - a);
        out[i] = 1 - t;
        out[i + 1] = t;
        break;
      }
    }
  }
  return out;
}

function findSkinned(root) {
  const out = [];
  root.traverse((o) => { if (o.isSkinnedMesh) out.push(o); });
  return out;
}

// Heights and reach (metres, bind pose) where the kit changes, taken from the
// skeleton rather than hard-coded so a different body still dresses right.
function kitBounds(scene) {
  const y = (name) => worldOf(scene, name).y;
  const x = (name) => Math.abs(worldOf(scene, name).x);
  const ankle = y('foot_l');
  const knee = y('calf_l');
  const hip = y('thigh_l');
  const neck = y('neck_01');
  const shoulder = x('upperarm_l');
  const elbow = x('lowerarm_l');
  return {
    boot: ankle + 0.035,
    sock: knee - 0.05,
    shortsHem: knee + 0.13,
    waist: hip + 0.1,
    collar: neck - 0.015,
    sleeve: shoulder + (elbow - shoulder) * 0.5,
    headCutoff: (neck + y('Head')) * 0.5,
  };
}

function worldOf(scene, name) {
  const node = scene.getObjectByName(name);
  if (!node) throw new Error(`bone ${name} missing from footballer`);
  return node.getWorldPosition(new node.position.constructor());
}

// Bind-pose world position of every vertex, which the kit shader reads.
function addRestPositions(THREE, mesh) {
  const pos = mesh.geometry.getAttribute('position');
  const rest = new Float32Array(pos.count * 3);
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).applyMatrix4(mesh.bindMatrix);
    rest[i * 3] = v.x;
    rest[i * 3 + 1] = v.y;
    rest[i * 3 + 2] = v.z;
  }
  mesh.geometry.setAttribute('kitRest', new THREE.BufferAttribute(rest, 3));
}

const KIT_GLSL = `
uniform float kitBoot, kitSock, kitHem, kitWaist, kitCollar, kitSleeve;
// x jersey, y shorts, z socks, w boots
vec4 kitRegions(vec3 p) {
  float e = 0.01;
  float ax = abs(p.x);
  float aboveBoot = smoothstep(kitBoot - e, kitBoot + e, p.y);
  float boots = 1.0 - aboveBoot;
  float socks = aboveBoot * (1.0 - smoothstep(kitSock - e, kitSock + e, p.y));
  float shorts = smoothstep(kitHem - e, kitHem + e, p.y) * (1.0 - smoothstep(kitWaist - e, kitWaist + e, p.y));
  float jersey = smoothstep(kitWaist - e, kitWaist + e, p.y)
    * (1.0 - smoothstep(kitCollar - e, kitCollar + e, p.y))
    * (1.0 - smoothstep(kitSleeve - e, kitSleeve + e, ax));
  return vec4(jersey, shorts, socks, boots);
}
`;

function kitMaterial(THREE, base, b, jersey, skinTone) {
  const m = base.clone();
  m.color.copy(skinTone);
  // Authored human skin colour must not tint white fur or green scales.
  m.map = null;
  const uniforms = {
    kitBoot: { value: b.boot },
    kitSock: { value: b.sock },
    kitHem: { value: b.shortsHem },
    kitWaist: { value: b.waist },
    kitCollar: { value: b.collar },
    kitSleeve: { value: b.sleeve },
    kitShirt: { value: new THREE.Color(jersey.primary) },
    kitTrim: { value: new THREE.Color(jersey.secondary) },
    kitShorts: { value: new THREE.Color(jersey.secondary) },
    kitSocks: { value: new THREE.Color(jersey.primary) },
    kitBoots: { value: new THREE.Color('#141414') },
    characterHeadCutoff: { value: b.headCutoff },
  };
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\nattribute vec3 kitRest;\nvarying vec3 vKitRest;\n${KIT_GLSL}`)
      .replace(
        '#include <begin_vertex>',
        // Cloth sits a few millimetres proud of the skin it covers.
        `#include <begin_vertex>
        vKitRest = kitRest;
        vec4 kr = kitRegions(kitRest);
        transformed += objectNormal * (kr.x * 0.012 + kr.y * 0.01 + kr.z * 0.004 + kr.w * 0.006);`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 vKitRest;
        uniform float characterHeadCutoff;
        uniform vec3 kitShirt, kitTrim, kitShorts, kitSocks, kitBoots;
        ${KIT_GLSL}`,
      )
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
        if (vKitRest.y > characterHeadCutoff) discard;
        vec4 kr = kitRegions(vKitRest);
        float kitCover = clamp(kr.x + kr.y + kr.z + kr.w, 0.0, 1.0);
        float ax = abs(vKitRest.x);
        // Trim on the cuffs and collar, and a band at the top of the socks.
        float cuff = smoothstep(kitSleeve - 0.03, kitSleeve - 0.02, ax);
        float collar = smoothstep(kitCollar - 0.025, kitCollar - 0.015, vKitRest.y);
        float band = smoothstep(kitSock - 0.04, kitSock - 0.03, vKitRest.y);
        vec3 shirt = mix(kitShirt, kitTrim, max(cuff, collar));
        vec3 socks = mix(kitSocks, kitTrim, band);
        vec3 kitColour = shirt * kr.x + kitShorts * kr.y + socks * kr.z + kitBoots * kr.w;
        diffuseColor.rgb = mix(diffuseColor.rgb, kitColour, kitCover);`,
      )
      .replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>\nvec3 kitBaseNormal = normal;')
      // Fabric hides the muscle detail the skin normal map carries.
      .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\nnormal = normalize(mix(normal, kitBaseNormal, kitCover * 0.85));')
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, kr.w > 0.5 ? 0.45 : 0.8, kitCover);');
  };
  m.customProgramCacheKey = () => 'footballer-species-kit';
  return m;
}

// The replacement head supplies its own shadow; the clipped human head must
// also disappear from Three's directional-light depth pass.
function characterDepthMaterial(THREE, cutoff) {
  const material = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, skinning: true });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.characterHeadCutoff = { value: cutoff };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec3 kitRest;\nvarying float vCharacterHeight;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvCharacterHeight = kitRest.y;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vCharacterHeight;\nuniform float characterHeadCutoff;')
      .replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>\nif (vCharacterHeight > characterHeadCutoff) discard;');
  };
  material.customProgramCacheKey = () => 'footballer-species-depth';
  return material;
}

function hashId(id) {
  const s = String(id);
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
