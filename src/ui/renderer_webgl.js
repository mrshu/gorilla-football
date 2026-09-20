// WebGL renderer (three.js). Real lighting and shadows, a textured pitch and
// a stadium bowl. The match itself is unchanged: this only draws it.
//
// The view is driven by the same `Camera` used for input maths, so the 2D
// overlay (HUD, the line you draw) lines up exactly with what is rendered
// here. World axes are (x along the pitch, y across it, z up); three.js is
// y-up, so the mapping is (x, z, -y), which preserves handedness.

import { PITCH } from '../game/constants.js';
import { Camera, frameBall } from './camera.js';
import { pitchTexture, crowdTexture, ballTexture } from './textures.js';

const toThree = (THREE, x, y, z = 0) => new THREE.Vector3(x, z, -y);

export class RendererWebGL {
  constructor(canvas, THREE) {
    this.canvas = canvas;
    this.THREE = THREE;
    this.camera = new Camera(); // shared with input; the source of truth
    this.smoothBall = null;
    this.playerViews = new Map();

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    // Leave the output in linear space. r128 has no colour management, so
    // re-encoding to sRGB here would brighten every authored colour and the
    // grass would come out mint instead of green.

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#5c8fb8');
    this.scene.fog = new THREE.Fog('#7aa6c6', 150, 330);

    this.three = new THREE.PerspectiveCamera(50, 1, 0.5, 600);
    this.three.up.set(0, 1, 0);

    this.buildLights();
    this.buildPitch();
    this.buildStands();
    this.buildGoals();
    this.buildBall();
  }

  // ------------------------------------------------------------- scenery

  buildLights() {
    const { THREE, scene } = this;
    scene.add(new THREE.HemisphereLight(0xcfe4ff, 0x3b7a45, 0.95));
    const key = new THREE.DirectionalLight(0xfff6e6, 1.0);
    key.position.set(PITCH.length * 0.35, 90, 60);
    key.target.position.set(PITCH.length / 2, 0, -PITCH.width / 2);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    // The frustum has to cover everything the camera can see. Anything outside
    // it renders as if fully shadowed, which shows up as a hard dark band
    // straight across the pitch.
    const span = 130;
    key.shadow.camera.left = -span;
    key.shadow.camera.right = span;
    key.shadow.camera.top = span;
    key.shadow.camera.bottom = -span;
    key.shadow.camera.near = 5;
    key.shadow.camera.far = 420;
    key.shadow.bias = -0.0022;
    scene.add(key);
    scene.add(key.target);
    this.keyLight = key;
    const fill = new THREE.DirectionalLight(0xdcebff, 0.3);
    fill.position.set(PITCH.length * 0.7, 50, -90);
    scene.add(fill);
  }

  buildPitch() {
    const { THREE, scene } = this;
    const { texture, width, height, margin } = pitchTexture(THREE);
    const geo = new THREE.PlaneGeometry(width, height);
    const mat = new THREE.MeshLambertMaterial({ map: texture });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(PITCH.length / 2, 0, -PITCH.width / 2);
    mesh.receiveShadow = true;
    scene.add(mesh);
    void margin;
    // Darker ground running out to the stands.
    const surround = new THREE.Mesh(
      new THREE.PlaneGeometry(width + 120, height + 120),
      new THREE.MeshLambertMaterial({ color: '#1e5427' }),
    );
    surround.rotation.x = -Math.PI / 2;
    surround.position.set(PITCH.length / 2, -0.02, -PITCH.width / 2);
    scene.add(surround);
  }

  // Four stands around the pitch. Each is a pair of plain boxes, a lower and
  // an upper tier set further back, which reads as a raked terrace without any
  // rotation maths to get wrong. World y maps to three z as -y.
  buildStands() {
    const { THREE, scene } = this;
    const crowd = crowdTexture(THREE);
    const concrete = new THREE.MeshLambertMaterial({ color: '#33424d' });
    const L = PITCH.length;
    const W = PITCH.width;
    const track = 7; // clear space between touchline and first row
    const over = 24; // how far the side stands run past the goal lines

    const tier = (w, h, d, cx, cy, baseY, repeatX) => {
      const mat = new THREE.MeshLambertMaterial({ map: crowd.clone() });
      mat.map.wrapS = THREE.RepeatWrapping;
      mat.map.wrapT = THREE.RepeatWrapping;
      mat.map.repeat.set(repeatX, 1);
      mat.map.needsUpdate = true;
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
      // cx, cy are world coordinates of the block's centre.
      m.position.set(cx, baseY + h / 2, -cy);
      scene.add(m);
      // A dark lip along the top so the stand has an edge against the sky.
      const lip = new THREE.Mesh(new THREE.BoxGeometry(w * 1.02, 1.4, d * 1.02), concrete);
      lip.position.set(cx, baseY + h + 0.7, -cy);
      scene.add(lip);
      return m;
    };

    const sideLen = L + over * 2;
    const endLen = W + over * 2;
    const d1 = 13;
    const d2 = 15;
    // Touchline stands, at world y below 0 and above W.
    for (const sign of [-1, 1]) {
      const y0 = sign < 0 ? -track : W + track;
      tier(sideLen, 9, d1, L / 2, y0 + sign * d1 / 2, 1.5, sideLen / 32);
      tier(sideLen, 11, d2, L / 2, y0 + sign * (d1 + d2 / 2), 9.5, sideLen / 32);
    }
    // Stands behind each goal.
    for (const sign of [-1, 1]) {
      const x0 = sign < 0 ? -track : L + track;
      tier(d1, 9, endLen, x0 + sign * d1 / 2, W / 2, 1.5, d1 / 20);
      tier(d2, 11, endLen, x0 + sign * (d1 + d2 / 2), W / 2, 9.5, d2 / 20);
    }
  }

  buildGoals() {
    const { THREE, scene } = this;
    const post = new THREE.MeshLambertMaterial({ color: '#ffffff' });
    const net = new THREE.MeshLambertMaterial({ color: '#dfe8ef', transparent: true, opacity: 0.22, side: THREE.DoubleSide });
    const r = 0.07;
    const hw = PITCH.goalWidth / 2;
    const h = PITCH.goalHeight;
    const d = PITCH.goalDepth;
    for (const side of [-1, 1]) {
      const x = side < 0 ? 0 : PITCH.length;
      const inward = side < 0 ? 1 : -1;
      const g = new THREE.Group();
      const bar = (len2, pos, axis) => {
        const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len2, 10), post);
        m.position.copy(pos);
        if (axis === 'z') m.rotation.x = Math.PI / 2;
        if (axis === 'x') m.rotation.z = Math.PI / 2;
        m.castShadow = true;
        g.add(m);
      };
      bar(h, toThree(THREE, x, PITCH.width / 2 - hw, h / 2), 'y');
      bar(h, toThree(THREE, x, PITCH.width / 2 + hw, h / 2), 'y');
      bar(PITCH.goalWidth, toThree(THREE, x, PITCH.width / 2, h), 'z');
      // Net: back panel and roof.
      const back = new THREE.Mesh(new THREE.PlaneGeometry(PITCH.goalWidth, h), net);
      back.position.copy(toThree(THREE, x - inward * d, PITCH.width / 2, h / 2));
      back.rotation.y = side < 0 ? -Math.PI / 2 : Math.PI / 2;
      g.add(back);
      const roof = new THREE.Mesh(new THREE.PlaneGeometry(PITCH.goalWidth, d), net);
      roof.position.copy(toThree(THREE, x - inward * d / 2, PITCH.width / 2, h));
      roof.rotation.x = -Math.PI / 2;
      g.add(roof);
      for (const sy of [-hw, hw]) {
        const sidePanel = new THREE.Mesh(new THREE.PlaneGeometry(d, h), net);
        sidePanel.position.copy(toThree(THREE, x - inward * d / 2, PITCH.width / 2 + sy, h / 2));
        g.add(sidePanel);
      }
      scene.add(g);
    }
  }

  buildBall() {
    const { THREE, scene } = this;
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(0.22, 18, 14),
      new THREE.MeshLambertMaterial({ map: ballTexture(THREE) }),
    );
    mesh.castShadow = true;
    scene.add(mesh);
    this.ballMesh = mesh;
    // A soft contact shadow so the ball reads against the grass when low.
    const blob = new THREE.Mesh(
      new THREE.CircleGeometry(0.3, 14),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.32 }),
    );
    blob.rotation.x = -Math.PI / 2;
    scene.add(blob);
    this.ballShadow = blob;
  }

  // -------------------------------------------------------------- players

  playerView(p) {
    let view = this.playerViews.get(p.id);
    if (view) return view;
    const { THREE, scene } = this;
    const size = p.character.look.size;
    const group = new THREE.Group();
    const shirt = new THREE.MeshLambertMaterial({ color: p.jersey.primary });
    const shorts = new THREE.MeshLambertMaterial({ color: shade(p.jersey.primary, -0.45) });
    const skin = new THREE.MeshLambertMaterial({ color: p.character.look.skin });
    const accent = new THREE.MeshLambertMaterial({ color: p.character.look.accent });

    // A plain cylinder rather than a capsule: capsules only exist in newer
    // three.js releases and this has to work on whatever the CDN serves.
    const torso = new THREE.Mesh(
      new THREE.CylinderGeometry(0.3 * size, 0.34 * size, 0.92 * size, 12),
      shirt,
    );
    torso.position.y = 1.05 * size;
    torso.castShadow = true;
    group.add(torso);

    for (const dx of [-0.17, 0.17]) {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.12 * size, 0.1 * size, 0.72 * size, 8), shorts);
      leg.position.set(dx * size, 0.36 * size, 0);
      leg.castShadow = true;
      group.add(leg);
    }
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.24 * size, 14, 10), skin);
    head.position.y = 1.62 * size;
    head.castShadow = true;
    group.add(head);
    // A dab of the character's accent colour so the roster stays readable.
    const cap = new THREE.Mesh(new THREE.SphereGeometry(0.245 * size, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2.4), accent);
    cap.position.y = 1.63 * size;
    group.add(cap);

    // Ring under the player the human is playing through.
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.55 * size, 0.78 * size, 22),
      new THREE.MeshBasicMaterial({ color: 0xffe600, transparent: true, opacity: 0.9, side: THREE.DoubleSide }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.03;
    ring.visible = false;
    group.add(ring);

    scene.add(group);
    view = { group, ring, torso };
    this.playerViews.set(p.id, view);
    return view;
  }

  // ---------------------------------------------------------------- frame

  updateCamera(match, layout, dt) {
    const target = match.ball.pos;
    if (!this.smoothBall) this.smoothBall = { ...target };
    const k = 1 - Math.exp(-6 * Math.max(0, Math.min(dt, 0.1)));
    this.smoothBall.x += (target.x - this.smoothBall.x) * k;
    this.smoothBall.y += (target.y - this.smoothBall.y) * k;
    this.camera.setViewport(layout.w, layout.h);
    frameBall(this.camera, this.smoothBall, layout.viewAttackDir, layout.portrait);
    const { THREE } = this;
    const e = this.camera.eye;
    const t = this.camera.target;
    this.three.position.copy(toThree(THREE, e.x, e.y, e.z));
    this.three.lookAt(toThree(THREE, t.x, t.y, t.z));
    this.three.fov = (this.camera.fovY * 180) / Math.PI;
    this.three.aspect = layout.w / Math.max(1, layout.h);
    this.three.updateProjectionMatrix();
    // Keep the shadow frustum over the play.
    this.keyLight.position.set(this.smoothBall.x + 40, 140, 90);
    this.keyLight.target.position.copy(toThree(THREE, this.smoothBall.x, this.smoothBall.y, 0));
    this.keyLight.target.updateMatrixWorld();
    this.keyLight.shadow.camera.updateProjectionMatrix();
  }

  resetCamera(match, layout) {
    this.smoothBall = { ...match.ball.pos };
    if (layout) this.updateCamera(match, layout, 1);
  }

  setSize(w, h) {
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(w, h, false);
  }

  draw(match, layout, opts = {}) {
    const { THREE } = this;
    this.updateCamera(match, layout, opts.dt || 0);

    for (const p of match.players) {
      const view = this.playerView(p);
      if (p.sentOff) {
        view.group.visible = false;
        continue;
      }
      view.group.visible = true;
      view.group.position.copy(toThree(THREE, p.pos.x, p.pos.y, 0));
      // Face the way they are running.
      const f = p.facing;
      view.group.rotation.y = Math.atan2(f.x, -f.y) - Math.PI / 2;
      const lean = p.sliding > 0 ? 1.1 : 0;
      view.torso.rotation.x = lean;
      const controlled = opts.controlledIds && opts.controlledIds.has(p.id);
      view.ring.visible = Boolean(controlled);
      if (controlled) view.ring.material.color.set(p.human === 1 ? 0x00e5ff : 0xffe600);
    }

    const b = match.ball;
    this.ballMesh.position.copy(toThree(THREE, b.pos.x, b.pos.y, Math.max(0.22, b.z + 0.22)));
    this.ballMesh.rotation.x += 0.25;
    this.ballShadow.position.copy(toThree(THREE, b.pos.x, b.pos.y, 0.02));
    const lift = Math.min(1, b.z / 6);
    this.ballShadow.scale.setScalar(1 + lift * 1.4);
    this.ballShadow.material.opacity = 0.32 * (1 - lift * 0.7);

    this.renderer.render(this.scene, this.three);
  }

  dispose() {
    this.renderer.dispose();
  }
}

function shade(hex, amount) {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) =>
    Math.round(Math.max(0, Math.min(255, amount < 0 ? c * (1 + amount) : c + (255 - c) * amount))),
  );
  return `rgb(${ch[0]},${ch[1]},${ch[2]})`;
}
