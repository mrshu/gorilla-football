// WebGL renderer (three.js). Real lighting and shadows, a textured pitch and
// a stadium bowl. The match itself is unchanged: this only draws it.
//
// The view is driven by the same `Camera` used for input maths, so the 2D
// overlay (HUD, the line you draw) lines up exactly with what is rendered
// here. World axes are (x along the pitch, y across it, z up); three.js is
// y-up, so the mapping is (x, z, -y), which preserves handedness.

import { PITCH } from '../game/constants.js';
import { Camera, frameSideline, frameFirstPerson, sidelinePose, shootingPose, isInShootingRange, applyPose, blendPose } from './camera.js';
import { pitchTexture, crowdTexture, ballTexture } from './textures.js';

const toThree = (THREE, x, y, z = 0) => new THREE.Vector3(x, z, -y);

export class RendererWebGL {
  constructor(canvas, THREE) {
    this.canvas = canvas;
    this.THREE = THREE;
    this.camera = new Camera(); // shared with input; the source of truth
    this.smoothBall = null;
    this.playerViews = new Map();
    this.pose = null;

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    // Leave the output in linear space. r128 has no colour management, so
    // re-encoding to sRGB here would brighten every authored colour and the
    // grass would come out mint instead of green.

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#101429');
    this.scene.fog = new THREE.Fog('#2b3158', 150, 330);

    this.three = new THREE.PerspectiveCamera(50, 1, 0.5, 600);
    this.three.up.set(0, 1, 0);

    this.buildLights();
    this.buildPitch();
    this.buildStands();
    this.buildFloodlights();
    this.buildGoals();
    this.buildBall();
  }

  // ------------------------------------------------------------- scenery

  buildLights() {
    const { THREE, scene } = this;
    scene.add(new THREE.HemisphereLight(0x8e9dff, 0x10251b, 0.62));
    const key = new THREE.DirectionalLight(0xffe4b0, 0.72);
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
    const fill = new THREE.DirectionalLight(0x6674d8, 0.2);
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
      new THREE.MeshLambertMaterial({ color: '#142f2b' }),
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
    const concrete = new THREE.MeshLambertMaterial({ color: '#171d35' });
    const L = PITCH.length;
    const W = PITCH.width;
    const track = 7; // clear space between touchline and first row
    const over = 24; // how far the side stands run past the goal lines

    this.nearStand = [];
    const tier = (w, h, d, cx, cy, baseY, repeatX, near = false) => {
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
      if (near) this.nearStand.push(m, lip);
      return m;
    };

    const sideLen = L + over * 2;
    const endLen = W + over * 2;
    const d1 = 13;
    const d2 = 15;
    // Touchline stands, at world y below 0 and above W.
    for (const sign of [-1, 1]) {
      const y0 = sign < 0 ? -track : W + track;
      // The broadcast camera films from the stand on the near touchline, so
      // that one is hidden in that view: you never see the stand you are in.
      const near = sign < 0;
      tier(sideLen, 9, d1, L / 2, y0 + sign * d1 / 2, 1.5, sideLen / 32, near);
      tier(sideLen, 11, d2, L / 2, y0 + sign * (d1 + d2 / 2), 9.5, sideLen / 32, near);
    }
    // Stands behind each goal.
    for (const sign of [-1, 1]) {
      const x0 = sign < 0 ? -track : L + track;
      tier(d1, 9, endLen, x0 + sign * d1 / 2, W / 2, 1.5, d1 / 20);
      tier(d2, 11, endLen, x0 + sign * (d1 + d2 / 2), W / 2, 9.5, d2 / 20);
    }
  }

  // Warm pools of light make the night stadium feel inhabited and keep the
  // character silhouettes readable without flattening the whole scene.
  buildFloodlights() {
    const { THREE, scene } = this;
    const postMat = new THREE.MeshLambertMaterial({ color: '#202844' });
    const lampMat = new THREE.MeshBasicMaterial({ color: '#ffd35c' });
    const lampPositions = [
      { x: 12, y: -18 },
      { x: PITCH.length - 12, y: -18 },
      { x: 12, y: PITCH.width + 18 },
      { x: PITCH.length - 12, y: PITCH.width + 18 },
    ];
    for (const pos of lampPositions) {
      const mast = new THREE.Group();
      mast.position.copy(toThree(THREE, pos.x, pos.y, 0));
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.4, 17, 8), postMat);
      post.position.y = 8.5;
      post.castShadow = true;
      mast.add(post);
      const arm = new THREE.Mesh(new THREE.BoxGeometry(2.8, 0.18, 0.18), postMat);
      arm.position.set(0, 17.1, pos.y < 0 ? -0.8 : 0.8);
      mast.add(arm);
      for (let i = -2; i <= 2; i++) {
        const lamp = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.2, 0.12), lampMat);
        lamp.position.set(i * 0.5, 17.25, pos.y < 0 ? -0.92 : 0.92);
        mast.add(lamp);
      }
      scene.add(mast);
      const glow = new THREE.PointLight(0xffd35c, 1.1, 105, 2);
      glow.position.copy(toThree(THREE, pos.x, pos.y, 16.8));
      scene.add(glow);
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

  // A stylized footballer built from low-poly primitives. The base rig is
  // shared across the roster, while the character-specific shell, hat, muzzle
  // or belly gives every animal a readable silhouette from the broadcast view.
  playerView(p) {
    const { THREE, scene } = this;
    let view = this.playerViews.get(p.id);
    const signature = [p.character.id, p.jersey.primary, p.jersey.secondary].join('|');
    if (view && view.signature === signature) return view;
    // Matches can be restarted with a different character or kit while the
    // renderer lives on. Rebuild that player's visual instead of leaving the
    // previous model cached under the same simulation id.
    if (view) scene.remove(view.group);
    const size = p.character.look.size * 1.4;
    const S = (n) => n * size;
    const group = new THREE.Group();

    const material = (color, roughness = 0.84) => new THREE.MeshStandardMaterial({ color, roughness, metalness: 0.02 });
    const shirt = material(p.jersey.primary);
    const shortsMat = material(shade(p.jersey.primary, -0.5));
    const sockMat = material(p.jersey.secondary);
    const skin = material(p.character.look.skin, 0.92);
    const hairMat = material(p.character.look.accent);
    const accent = material(p.character.look.accent);
    const white = material('#f5f4e9', 0.9);
    const black = material('#111321', 0.72);
    const boot = material('#23262b', 0.62);

    const mesh = (geo, mat, x = 0, y = 0, z = 0) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      m.castShadow = true;
      return m;
    };

    const sphere = (mat, x, y, z, sx = 1, sy = 1, sz = 1, segments = 12) => {
      const m = mesh(new THREE.SphereGeometry(S(0.16), segments, 8), mat, S(x), S(y), S(z));
      m.scale.set(sx, sy, sz);
      return m;
    };

    const eye = (x, y, z = -0.15) => sphere(black, x, y, z, 0.7, 0.8, 0.42, 8);

    // Legs: thigh, shin and boot, hung off a hip pivot so they can swing.
    const legs = [];
    for (const side of [-1, 1]) {
      const hip = new THREE.Group();
      hip.position.set(side * S(0.13), S(0.82), 0);
      hip.add(mesh(new THREE.CylinderGeometry(S(0.1), S(0.085), S(0.42), 8), shortsMat, 0, S(-0.21), 0));
      const knee = new THREE.Group();
      knee.position.set(0, S(-0.42), 0);
      knee.add(mesh(new THREE.CylinderGeometry(S(0.075), S(0.06), S(0.4), 8), sockMat, 0, S(-0.2), 0));
      knee.add(mesh(new THREE.BoxGeometry(S(0.16), S(0.09), S(0.3)), boot, 0, S(-0.42), S(0.05)));
      hip.add(knee);
      group.add(hip);
      legs.push({ hip, knee });
    }

    // Shorts, torso, collar and a clean kit stripe give the model a stronger
    // silhouette than a stack of unadorned cylinders.
    group.add(mesh(new THREE.SphereGeometry(S(0.32), 12, 8), shortsMat, 0, S(0.92), 0));
    const torso = mesh(new THREE.SphereGeometry(S(0.39), 12, 9), shirt, 0, S(1.34), 0);
    torso.scale.set(0.78, 1.05, 0.62);
    group.add(torso);
    group.add(mesh(new THREE.TorusGeometry(S(0.22), S(0.035), 6, 12), accent, 0, S(1.65), 0));
    const stripe = mesh(new THREE.BoxGeometry(S(0.48), S(0.07), S(0.035)), accent, 0, S(1.35), S(-0.24));
    stripe.castShadow = false;
    group.add(stripe);
    // Shoulders, so the silhouette is not a tube.
    group.add(sphere(shirt, -0.26, 1.55, 0, 1.05, 0.95, 0.9));
    group.add(sphere(shirt, 0.26, 1.55, 0, 1.05, 0.95, 0.9));

    // Arms: a sleeve in the shirt colour, then a bare forearm.
    const arms = [];
    for (const side of [-1, 1]) {
      const shoulder = new THREE.Group();
      shoulder.position.set(side * S(0.3), S(1.56), 0);
      shoulder.add(mesh(new THREE.CylinderGeometry(S(0.09), S(0.065), S(0.29), 8), shirt, 0, S(-0.14), 0));
      shoulder.add(mesh(new THREE.CylinderGeometry(S(0.065), S(0.05), S(0.29), 8), skin, 0, S(-0.43), 0));
      shoulder.add(sphere(skin, 0, -0.61, 0, 0.72, 0.72, 0.72, 8));
      group.add(shoulder);
      arms.push(shoulder);
    }

    // Neck, head, eyes and a small mouth/visor cue. The face is intentionally
    // graphic so it reads even when a player is only a few pixels tall.
    group.add(mesh(new THREE.CylinderGeometry(S(0.08), S(0.09), S(0.1), 8), skin, 0, S(1.66), 0));
    const head = mesh(new THREE.SphereGeometry(S(0.2), 14, 10), skin, 0, S(1.84), 0);
    head.scale.set(0.95, 1.1, 0.92);
    group.add(head);
    group.add(eye(-0.075, 1.88));
    group.add(eye(0.075, 1.88));
    const mouth = mesh(new THREE.BoxGeometry(S(0.12), S(0.025), S(0.025)), black, 0, S(1.75), S(-0.175));
    mouth.castShadow = false;
    group.add(mouth);

    const shape = p.character.look.shape;
    if (shape === 'gorilla') {
      group.add(sphere(hairMat, 0, 1.96, 0.01, 1.5, 1.05, 1.1, 10));
      group.add(sphere(accent, 0, 1.78, -0.19, 1.0, 0.62, 0.35, 10));
      group.add(sphere(accent, -0.23, 1.86, 0, 0.58, 0.7, 0.55, 8));
      group.add(sphere(accent, 0.23, 1.86, 0, 0.58, 0.7, 0.55, 8));
      group.add(sphere(shirt, -0.36, 1.38, 0, 1.15, 1.25, 1.05, 10));
      group.add(sphere(shirt, 0.36, 1.38, 0, 1.15, 1.25, 1.05, 10));
    } else if (shape === 'tortoise') {
      const shell = mesh(new THREE.DodecahedronGeometry(S(0.42), 1), accent, 0, S(1.35), S(0.24));
      shell.scale.set(1.1, 1.05, 0.48);
      group.add(shell);
      group.add(sphere(accent, 0, 1.98, 0, 0.88, 0.72, 0.9, 10));
      group.add(sphere(skin, 0, 1.76, -0.19, 0.72, 0.62, 0.38, 10));
    } else if (shape === 'wizard') {
      const brim = mesh(new THREE.CylinderGeometry(S(0.28), S(0.28), S(0.06), 12), accent, 0, S(2.03), 0);
      const hat = mesh(new THREE.ConeGeometry(S(0.2), S(0.48), 12), accent, 0, S(2.28), 0);
      hat.rotation.z = -0.16;
      group.add(brim, hat);
      group.add(sphere(white, 0, 1.78, -0.18, 0.55, 0.42, 0.25, 8));
    } else if (shape === 'rocket') {
      const helmet = mesh(new THREE.SphereGeometry(S(0.23), 12, 8), accent, 0, S(1.91), 0);
      helmet.scale.set(1, 0.78, 0.95);
      group.add(helmet);
      const visor = mesh(new THREE.BoxGeometry(S(0.27), S(0.09), S(0.025)), black, 0, S(1.9), S(-0.21));
      visor.castShadow = false;
      group.add(visor);
      for (const side of [-1, 1]) {
        const fin = mesh(new THREE.ConeGeometry(S(0.1), S(0.3), 4), accent, side * S(0.37), S(1.1), S(0.08));
        fin.rotation.z = side * Math.PI / 2;
        group.add(fin);
      }
    } else if (shape === 'penguin') {
      // Keep the dark body just behind the kit so the penguin reads clearly
      // without losing the shirt, stripe, or team colour at match distance.
      group.add(sphere(black, 0, 1.37, 0.2, 0.98, 1.04, 0.82, 10));
      group.add(sphere(white, 0, 1.38, -0.24, 0.62, 0.88, 0.28, 10));
      const beak = mesh(new THREE.ConeGeometry(S(0.09), S(0.2), 4), accent, 0, S(1.77), S(-0.29));
      beak.rotation.x = Math.PI / 2;
      group.add(beak);
    } else if (shape === 'yeti') {
      group.add(sphere(white, 0, 1.96, 0, 1.35, 1.25, 1.2, 10));
      group.add(sphere(accent, 0, 1.79, -0.2, 0.72, 0.55, 0.32, 10));
      group.add(sphere(white, -0.36, 1.42, 0.1, 0.9, 1.05, 0.82, 10));
      group.add(sphere(white, 0.36, 1.42, 0.1, 0.9, 1.05, 0.82, 10));
    } else {
      // Plumber: a cap and moustache keep the roster distinct without making
      // the kit unreadable.
      const cap = mesh(new THREE.SphereGeometry(S(0.23), 12, 8), accent, 0, S(1.99), 0);
      cap.scale.set(1.05, 0.54, 1.05);
      group.add(cap);
      group.add(mesh(new THREE.BoxGeometry(S(0.32), S(0.04), S(0.14)), accent, 0, S(1.92), S(-0.16)));
      group.add(sphere(hairMat, 0, 1.74, -0.2, 0.7, 0.32, 0.2, 8));
    }

    const ring = new THREE.Mesh(
      new THREE.RingGeometry(S(0.64), S(0.88), 32),
      new THREE.MeshBasicMaterial({ color: 0xffd35c, transparent: true, opacity: 0.92, side: THREE.DoubleSide }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.03;
    ring.visible = false;
    group.add(ring);

    scene.add(group);
    view = { group, ring, torso, legs, arms, head, phase: Math.random() * Math.PI * 2, bob: 0, size, signature };
    this.playerViews.set(p.id, view);
    return view;
  }

  // Swing the limbs in time with how fast the player is actually moving.
  animate(view, p, dt) {
    const speed = Math.hypot(p.vel.x, p.vel.y);
    view.phase += speed * dt * 1.7;
    const swing = Math.min(1, speed / 7) * 0.85;
    const a = Math.sin(view.phase) * swing;
    view.legs[0].hip.rotation.x = a;
    view.legs[1].hip.rotation.x = -a;
    // Knees only bend one way.
    view.legs[0].knee.rotation.x = Math.max(0, -a * 0.9);
    view.legs[1].knee.rotation.x = Math.max(0, a * 0.9);
    view.arms[0].rotation.x = -a * 0.7;
    view.arms[1].rotation.x = a * 0.7;
    view.bob = Math.sin(view.phase * 2) * Math.min(0.035, speed * 0.004);
    view.head.rotation.z = Math.sin(view.phase * 2) * 0.025;
    // Lean into a sprint, and fall flat when sliding.
    view.group.rotation.x = p.sliding > 0 ? -1.15 : -Math.min(0.22, speed * 0.022);
  }

  // ---------------------------------------------------------------- frame

  updateCamera(match, layout, dt) {
    const target = match.ball.pos;
    if (!this.smoothBall) this.smoothBall = { ...target };
    const k = 1 - Math.exp(-6 * Math.max(0, Math.min(dt, 0.1)));
    this.smoothBall.x += (target.x - this.smoothBall.x) * k;
    this.smoothBall.y += (target.y - this.smoothBall.y) * k;
    this.camera.setViewport(layout.w, layout.h);
    this.applyFraming(layout, dt);
    // Whatever framing was chosen, the three.js camera has to be pointed the
    // same way as the one the input and overlay use, or the line you draw
    // lands somewhere other than where the pitch appears to be.
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

  // Point `this.camera` (the shared projection) at whichever view applies.
  applyFraming(layout, dt) {
    if (layout.firstPerson && layout.eyePlayer) {
      frameFirstPerson(this.camera, layout.eyePlayer, this.smoothLook(layout, dt), layout.portrait);
      this.applySmoothedPose(cameraPose(this.camera), dt);
      this.shotBlend = 0;
      return;
    }
    // Drop in behind the player on the ball once they are in range of goal,
    // easing between the two so it reads as a camera move, not a cut.
    const want = layout.shooter ? 1 : 0;
    const rate = 1 - Math.exp(-1.8 * Math.max(0, Math.min(dt, 0.2)));
    this.shotBlend = (this.shotBlend || 0) + (want - (this.shotBlend || 0)) * rate;
    const wide = sidelinePose(this.smoothBall, layout.viewAttackDir, layout.portrait);
    if (this.shotBlend < 0.01 || !layout.shotAnchor) {
      this.applySmoothedPose(wide, dt);
      return;
    }
    const close = shootingPose(layout.shotAnchor.carrier, layout.shotAnchor.goal, layout.portrait);
    this.applySmoothedPose(blendPose(wide, close, this.shotBlend), dt);
  }

  applySmoothedPose(target, dt) {
    if (!this.pose || dt >= 0.9) {
      this.pose = target;
    } else {
      const amount = 1 - Math.exp(-1.65 * Math.max(0, Math.min(dt, 0.2)));
      this.pose = blendPose(this.pose, target, amount);
    }
    applyPose(this.camera, this.pose);
  }

  // Ease the point first person is looking at, so the view does not snap
  // every time possession changes.
  smoothLook(layout, dt) {
    const want = layout.lookAt;
    if (!this.smoothedLook) this.smoothedLook = { ...want };
    const k = 1 - Math.exp(-5 * Math.max(0, Math.min(dt, 0.1)));
    this.smoothedLook.x += (want.x - this.smoothedLook.x) * k;
    this.smoothedLook.y += (want.y - this.smoothedLook.y) * k;
    return this.smoothedLook;
  }

  resetCamera(match, layout) {
    this.smoothBall = { ...match.ball.pos };
    this.smoothedLook = layout && layout.lookAt ? { ...layout.lookAt } : null;
    this.pose = null;
    if (layout) this.updateCamera(match, layout, 1);
  }

  setSize(w, h) {
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(w, h, false);
  }

  draw(match, layout, opts = {}) {
    const { THREE } = this;
    this.updateCamera(match, layout, opts.dt || 0);
    const hideNear = !layout.firstPerson;
    for (const m of this.nearStand) m.visible = !hideNear;

    for (const p of match.players) {
      const view = this.playerView(p);
      if (p.sentOff) {
        view.group.visible = false;
        continue;
      }
      // In first person you are inside this player's head; drawing them would
      // fill the screen with the back of their own shirt.
      if (layout.firstPerson && layout.eyePlayer && layout.eyePlayer.id === p.id) {
        view.group.visible = false;
        continue;
      }
      view.group.visible = true;
      view.group.position.copy(toThree(THREE, p.pos.x, p.pos.y, 0));
      // Face the way they are running.
      const f = p.facing;
      view.group.rotation.y = Math.atan2(f.x, -f.y) - Math.PI / 2;
      this.animate(view, p, opts.dt || 0);
      view.group.position.y += view.bob;
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

function cameraPose(camera) {
  return {
    eye: { ...camera.eye },
    target: { ...camera.target },
    fov: (camera.fovY * 180) / Math.PI,
  };
}
