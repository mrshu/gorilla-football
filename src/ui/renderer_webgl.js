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
import { loadFootballers, createFootballer, animateFootballer } from './footballers.js';

const toThree = (THREE, x, y, z = 0) => new THREE.Vector3(x, z, -y);

export class RendererWebGL {
  constructor(canvas, THREE) {
    this.canvas = canvas;
    this.THREE = THREE;
    this.camera = new Camera(); // shared with input; the source of truth
    this.smoothBall = null;
    this.playerViews = new Map();
    this.spriteTextures = new Map();
    this.footballers = null;
    this.spriteGeometry = new THREE.PlaneGeometry(2 / 3, 1);
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
    this.loadPlayers();
  }

  // Rigged humanoids are the player model. The cutout sprites only stand in
  // if the models fail to load, and the primitive rig until either arrives.
  loadPlayers() {
    loadFootballers(this.THREE)
      .then((kit) => {
        this.footballers = kit;
        this.invalidatePlayerViews();
      })
      .catch((err) => {
        console.warn('footballer models unavailable, using sprites', err);
        this.loadPlayerSprites();
      });
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
    // Regulation goalposts are roughly 12 cm in diameter. Keep the *inside*
    // of the frame at the regulation dimensions, rather than putting the
    // post centers on the dimension lines and shrinking the visible opening.
    const r = 0.06;
    const hw = PITCH.goalWidth / 2 + r;
    const frameWidth = PITCH.goalWidth + r * 2;
    const h = PITCH.goalHeight + r;
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
      bar(frameWidth, toThree(THREE, x, PITCH.width / 2, h), 'z');
      // Net: back panel and roof.
      const back = new THREE.Mesh(new THREE.PlaneGeometry(frameWidth, h), net);
      back.position.copy(toThree(THREE, x - inward * d, PITCH.width / 2, h / 2));
      back.rotation.y = side < 0 ? -Math.PI / 2 : Math.PI / 2;
      g.add(back);
      const roof = new THREE.Mesh(new THREE.PlaneGeometry(frameWidth, d), net);
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

  // High-quality ImageGen cutouts are the primary broadcast character view.
  // They live as real world-space planes inside the Three.js scene, so they
  // still depth-test, scale with the pitch, and move with the simulation.
  loadPlayerSprites() {
    const shapes = ['gorilla', 'plumber', 'tortoise', 'rocket', 'wizard', 'penguin', 'yeti'];
    const load = (path) => new Promise((resolve) => {
      const image = new Image();
      image.onload = () => {
        const texture = new this.THREE.Texture(image);
        texture.needsUpdate = true;
        texture.minFilter = this.THREE.LinearFilter;
        texture.magFilter = this.THREE.LinearFilter;
        texture.generateMipmaps = true;
        if (this.THREE.sRGBEncoding !== undefined) texture.encoding = this.THREE.sRGBEncoding;
        resolve(texture);
      };
      image.onerror = () => resolve(null);
      image.src = path;
    });
    const loads = shapes.map(async (shape) => {
      const [idle, run] = await Promise.all([
        load(`public/assets/player-sprite-${shape}.png`),
        load(`public/assets/player-sprite-${shape}-run.png`),
      ]);
      if (idle && run) this.spriteTextures.set(shape, { idle, run });
    });
    Promise.all(loads).then(() => this.invalidatePlayerViews());
  }

  removePlayerView(view) {
    if (!view) return;
    this.scene.remove(view.group);
    if (view.shadow) this.scene.remove(view.shadow);
  }

  invalidatePlayerViews() {
    for (const view of this.playerViews.values()) this.removePlayerView(view);
    this.playerViews.clear();
  }

  spritePlayerView(p, signature, size) {
    const { THREE, scene } = this;
    const textures = this.spriteTextures.get(p.character.look.shape);
    const material = new THREE.ShaderMaterial({
      uniforms: {
        mapIdle: { value: textures.idle },
        mapRun: { value: textures.run },
        primary: { value: new THREE.Color(p.jersey.primary) },
        secondary: { value: new THREE.Color(p.jersey.secondary) },
        accent: { value: new THREE.Color(p.character.look.accent) },
        runMix: { value: 0 },
      },
      vertexShader: PLAYER_SPRITE_VERTEX,
      fragmentShader: PLAYER_SPRITE_FRAGMENT,
      transparent: true,
      alphaTest: 0.08,
      depthTest: true,
      depthWrite: true,
      side: THREE.DoubleSide,
    });
    const plane = new THREE.Mesh(this.spriteGeometry, material);
    const height = 1.82 + (p.character.look.size - 1) * 0.32;
    plane.position.y = height * 0.5;
    plane.scale.setScalar(height);
    plane.castShadow = false;
    const group = new THREE.Group();
    group.add(plane);

    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.58 * size, 0.76 * size, 32),
      new THREE.MeshBasicMaterial({ color: 0xffd35c, transparent: true, opacity: 0.92, side: THREE.DoubleSide }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.03;
    ring.visible = false;
    group.add(ring);

    const shadow = new THREE.Mesh(
      new THREE.CircleGeometry(0.32 * size, 18),
      new THREE.MeshBasicMaterial({ color: p.character.look.accent, transparent: true, opacity: 0.16, depthWrite: false }),
    );
    shadow.rotation.x = -Math.PI / 2;
    shadow.scale.set(1.45, 0.58, 1);
    scene.add(group, shadow);

    const view = {
      kind: 'sprite',
      group,
      plane,
      ring,
      shadow,
      material,
      phase: Math.random() * Math.PI * 2,
      bob: 0,
      height,
      size,
      signature,
    };
    this.playerViews.set(p.id, view);
    return view;
  }

  humanoidPlayerView(p, signature) {
    const { THREE, scene } = this;
    const footballer = createFootballer(this.footballers, p);
    const group = new THREE.Group();
    group.add(footballer.root);
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.5, 0.66, 32),
      new THREE.MeshBasicMaterial({ color: 0xffd35c, transparent: true, opacity: 0.92, side: THREE.DoubleSide }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.03;
    ring.visible = false;
    group.add(ring);
    scene.add(group);
    const view = { kind: 'humanoid', group, ring, footballer, heading: null, bob: 0, signature };
    this.playerViews.set(p.id, view);
    return view;
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
    if (view) this.removePlayerView(view);
    const look = p.character.look;
    const shape = look.shape;
    // Keep species readable without letting the old look-size range turn
    // ordinary players into giants next to a regulation goal.
    const size = 1 + (look.size - 1) * 0.45;
    if (this.footballers) return this.humanoidPlayerView(p, signature);
    if (this.spriteTextures.has(shape)) return this.spritePlayerView(p, signature, size);
    const S = (n) => n * size;
    const group = new THREE.Group();

    const material = (color, roughness = 0.84) => new THREE.MeshStandardMaterial({ color, roughness, metalness: 0.02 });
    const shirt = material(p.jersey.primary);
    const shortsMat = material(shade(p.jersey.primary, -0.5));
    const sockMat = material(p.jersey.secondary);
    const skin = material(look.skin, 0.92);
    const hairMat = material(look.accent);
    const accent = material(look.accent);
    const white = material('#f5f4e9', 0.9);
    const black = material('#111321', 0.72);
    const boot = material('#23262b', 0.62);
    const sole = material('#0d0f16', 0.58);

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

    const bone = (mat, from, to, startRadius, endRadius, segments = 10) => {
      const a = new THREE.Vector3(S(from[0]), S(from[1]), S(from[2]));
      const b = new THREE.Vector3(S(to[0]), S(to[1]), S(to[2]));
      const direction = new THREE.Vector3().subVectors(b, a);
      const length = direction.length();
      const m = mesh(new THREE.CylinderGeometry(S(endRadius), S(startRadius), length, segments), mat);
      m.position.copy(a).add(b).multiplyScalar(0.5);
      m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize());
      return m;
    };

    const lathe = (mat, profile, segments = 14) => {
      const points = profile.map(([radius, y]) => new THREE.Vector2(S(radius), S(y)));
      const geo = new THREE.LatheGeometry(points, segments);
      geo.computeVertexNormals();
      return mesh(geo, mat);
    };

    const box = (mat, x, y, z, sx, sy, sz) => mesh(
      new THREE.BoxGeometry(S(sx), S(sy), S(sz)),
      mat,
      S(x),
      S(y),
      S(z),
    );

    // Legs: thigh, shin and boot, hung off a hip pivot so they can swing.
    const legs = [];
    for (const side of [-1, 1]) {
      const hip = new THREE.Group();
      hip.position.set(side * S(0.14), S(0.96), 0);
      hip.add(bone(shortsMat, [0, 0, 0], [side * 0.035, -0.36, 0.01], 0.15, 0.11));
      const knee = new THREE.Group();
      knee.position.set(0, S(-0.36), 0);
      knee.add(bone(sockMat, [0, 0, 0], [side * 0.02, -0.39, 0.025], 0.105, 0.075));
      knee.add(box(boot, side * 0.015, -0.46, -0.055, 0.22, 0.13, 0.36));
      knee.add(box(sole, side * 0.015, -0.53, -0.07, 0.23, 0.035, 0.38));
      hip.add(knee);
      group.add(hip);
      legs.push({ hip, knee });
    }

    // A fitted jersey and separate pelvis give the character an actual torso
    // silhouette instead of the old stack of spheres.
    group.add(lathe(shortsMat, [
      [0.18, 0.72], [0.28, 0.76], [0.31, 0.94], [0.27, 1.06], [0.17, 1.1],
    ]));
    const torso = lathe(shirt, [
      [0.2, 1.0], [0.29, 1.05], [0.36, 1.2], [0.4, 1.42], [0.36, 1.58], [0.22, 1.68],
    ]);
    group.add(torso);
    const collar = mesh(new THREE.TorusGeometry(S(0.22), S(0.026), 6, 14), accent, 0, S(1.64), 0);
    collar.rotation.x = Math.PI / 2;
    collar.castShadow = false;
    group.add(collar);
    const stripe = box(accent, 0, 1.36, 0.35, 0.42, 0.055, 0.025);
    stripe.castShadow = false;
    group.add(stripe);
    const sidePanel = (side) => {
      const panel = box(accent, side * 0.34, 1.34, 0.08, 0.035, 0.42, 0.025);
      panel.castShadow = false;
      return panel;
    };
    group.add(sidePanel(-1), sidePanel(1));

    // Arms: a sleeve in the shirt colour, then a bare forearm.
    const arms = [];
    for (const side of [-1, 1]) {
      const shoulder = new THREE.Group();
      shoulder.position.set(side * S(0.34), S(1.55), 0);
      shoulder.add(bone(shirt, [0, 0, 0], [side * 0.015, -0.25, 0], 0.14, 0.095));
      shoulder.add(bone(skin, [side * 0.015, -0.23, 0], [side * 0.035, -0.53, -0.015], 0.095, 0.06));
      shoulder.add(sphere(skin, side * 0.035, -0.58, -0.02, 0.62, 0.68, 0.62, 8));
      group.add(shoulder);
      arms.push(shoulder);
    }

    // Neck and a compact face. The brows, nose, and mouth sit on separate
    // planes so the head reads as a character rather than a colored ball.
    group.add(mesh(new THREE.CylinderGeometry(S(0.08), S(0.09), S(0.1), 8), skin, 0, S(1.66), 0));
    const head = mesh(new THREE.SphereGeometry(S(0.17), 14, 10), skin, 0, S(1.84), 0);
    head.scale.set(0.92, 1.04, 0.86);
    group.add(head);
    const eye = (x) => sphere(black, x, 1.88, 0.17, 0.55, 0.72, 0.34, 8);
    group.add(eye(-0.07), eye(0.07));
    group.add(box(black, -0.07, 1.95, 0.18, 0.11, 0.025, 0.03));
    group.add(box(black, 0.07, 1.95, 0.18, 0.11, 0.025, 0.03));
    group.add(sphere(skin, 0, 1.82, 0.19, 0.26, 0.3, 0.24, 8));
    const mouth = box(black, 0, 1.75, 0.18, 0.11, 0.02, 0.025);
    mouth.castShadow = false;
    group.add(mouth);
    group.add(sphere(skin, -0.17, 1.85, 0, 0.28, 0.44, 0.3, 8));
    group.add(sphere(skin, 0.17, 1.85, 0, 0.28, 0.44, 0.3, 8));

    if (shape === 'gorilla') {
      const cap = mesh(new THREE.SphereGeometry(S(0.2), 14, 8, 0, Math.PI * 2, 0, Math.PI * 0.7), hairMat, 0, S(1.96), S(0.12));
      cap.scale.set(1.14, 1.12, 0.78);
      group.add(cap);
      group.add(sphere(accent, 0, 1.79, 0.19, 0.85, 0.56, 0.34, 10));
      group.add(box(hairMat, -0.16, 1.94, 0.17, 0.16, 0.045, 0.04));
      group.add(box(hairMat, 0.16, 1.94, 0.17, 0.16, 0.045, 0.04));
    } else if (shape === 'tortoise') {
      const shell = sphere(accent, -0.12, 1.38, 0.02, 1.18, 1.1, 0.62, 16);
      group.add(shell);
      const shellEdge = material(shade(look.accent, -0.18));
      const ridge = mesh(new THREE.TorusGeometry(S(0.32), S(0.022), 5, 16), shellEdge, -S(0.12), S(1.38), S(0.16));
      ridge.rotation.x = Math.PI / 2;
      ridge.scale.set(1.28, 0.92, 1);
      ridge.castShadow = false;
      group.add(ridge);
      group.add(sphere(skin, 0, 1.84, 0.2, 0.7, 0.64, 0.38, 10));
    } else if (shape === 'wizard') {
      const brim = mesh(new THREE.CylinderGeometry(S(0.28), S(0.28), S(0.06), 12), accent, 0, S(2.03), 0);
      const hat = mesh(new THREE.ConeGeometry(S(0.2), S(0.48), 12), accent, 0, S(2.28), 0);
      hat.rotation.z = -0.16;
      group.add(brim, hat);
      group.add(sphere(white, 0, 1.75, 0.18, 0.5, 0.52, 0.25, 8));
    } else if (shape === 'rocket') {
      const helmet = mesh(new THREE.SphereGeometry(S(0.23), 12, 8), accent, 0, S(1.91), 0);
      helmet.scale.set(1, 0.78, 0.95);
      group.add(helmet, box(black, 0, 1.9, 0.21, 0.27, 0.09, 0.025));
      const visor = group.children[group.children.length - 1];
      visor.castShadow = false;
      for (const side of [-1, 1]) {
        const fin = mesh(new THREE.ConeGeometry(S(0.1), S(0.3), 4), accent, side * S(0.37), S(1.1), S(0.08));
        fin.rotation.z = side * Math.PI / 2;
        group.add(fin);
      }
    } else if (shape === 'penguin') {
      // Keep the dark body just behind the kit so the penguin reads clearly
      // without losing the shirt, stripe, or team colour at match distance.
      group.add(sphere(black, 0, 1.37, 0.2, 0.98, 1.04, 0.82, 10));
      group.add(sphere(white, 0, 1.38, 0.24, 0.62, 0.88, 0.28, 10));
      const beak = mesh(new THREE.ConeGeometry(S(0.09), S(0.2), 4), accent, 0, S(1.77), S(0.29));
      beak.rotation.x = Math.PI / 2;
      group.add(beak);
    } else if (shape === 'yeti') {
      const cap = mesh(new THREE.SphereGeometry(S(0.2), 14, 8, 0, Math.PI * 2, 0, Math.PI * 0.72), white, 0, S(1.96), S(0.12));
      cap.scale.set(1.1, 1.12, 0.78);
      group.add(cap);
      group.add(sphere(accent, 0, 1.79, 0.2, 0.72, 0.55, 0.32, 10));
      group.add(sphere(white, -0.22, 1.42, 0.1, 0.72, 0.88, 0.72, 10));
      group.add(sphere(white, 0.22, 1.42, 0.1, 0.72, 0.88, 0.72, 10));
    } else {
      // Plumber: a cap and moustache keep the roster distinct without making
      // the kit unreadable.
      const cap = mesh(new THREE.SphereGeometry(S(0.23), 12, 8), accent, 0, S(1.99), 0);
      cap.position.z = S(0.1);
      cap.scale.set(1.05, 0.54, 0.72);
      group.add(cap);
      group.add(box(accent, 0, 1.92, 0.16, 0.32, 0.04, 0.14));
      group.add(sphere(hairMat, 0, 1.74, 0.2, 0.7, 0.32, 0.2, 8));
    }

    const ring = new THREE.Mesh(
      new THREE.RingGeometry(S(0.64), S(0.88), 32),
      new THREE.MeshBasicMaterial({ color: 0xffd35c, transparent: true, opacity: 0.92, side: THREE.DoubleSide }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.03;
    ring.visible = false;
    group.add(ring);
    // Give the otherwise stylized proportions a little more athlete-like
    // height without enlarging the selection footprint or boots.
    group.scale.y = 1.08;

    scene.add(group);
    view = { group, ring, torso, legs, arms, head, phase: Math.random() * Math.PI * 2, bob: 0, size, signature };
    this.playerViews.set(p.id, view);
    return view;
  }

  // Swing the limbs in time with how fast the player is actually moving.
  animate(view, p, dt) {
    if (view.kind === 'sprite') return this.animateSprite(view, p, dt);
    if (view.kind === 'humanoid') return animateFootballer(view.footballer, p, dt);
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

  animateSprite(view, p, dt) {
    const speed = Math.hypot(p.vel.x, p.vel.y);
    view.phase += dt * Math.max(1.6, Math.min(12, speed * 2.1));
    const moving = speed > 0.7;
    const slide = p.sliding > 0;
    const cycle = Math.sin(view.phase);
    const stride = moving ? cycle * 0.055 : Math.sin(view.phase * 0.75) * 0.008;
    const height = view.height;
    const stretch = moving ? 1 + cycle * 0.045 : 1 + Math.sin(view.phase * 0.75) * 0.012;
    const planeHeight = height * (slide ? 0.58 : stretch);
    view.plane.position.x = moving && !slide ? Math.cos(view.phase) * 0.045 : 0;
    view.plane.position.y = planeHeight * 0.5;
    view.plane.scale.set(height * (slide ? 1.06 : 1 - cycle * 0.018), planeHeight, height);
    view.plane.rotation.z = slide ? (p.facing.x >= 0 ? -0.58 : 0.58) : stride;
    view.material.uniforms.runMix.value = slide ? 1 : moving ? 0.5 + cycle * 0.5 : 0;
    view.bob = slide ? 0 : Math.sin(view.phase * 2) * Math.min(0.04, speed * 0.004);
  }

  // The model faces +z; turn it toward `facing`, quickly but not in one frame,
  // so a change of direction reads as a turn rather than a snap.
  turnHumanoid(view, p, dt) {
    const target = Math.atan2(p.facing.x, -p.facing.y);
    if (view.heading === null) view.heading = target;
    let delta = target - view.heading;
    delta = Math.atan2(Math.sin(delta), Math.cos(delta));
    view.heading += delta * (1 - Math.exp(-16 * dt));
    view.group.rotation.set(0, view.heading, 0);
  }

  faceSpriteToCamera(view, p) {
    const dx = this.three.position.x - view.group.position.x;
    const dz = this.three.position.z - view.group.position.z;
    const cameraAngle = Math.atan2(dx, dz);
    view.group.rotation.set(0, cameraAngle, 0);
    // The cutout stays readable, but a small facing offset stops the roster
    // from looking like twenty-two identical cards pasted onto the grass.
    const facingAngle = Math.atan2(p.facing.x, -p.facing.y);
    const delta = Math.atan2(Math.sin(facingAngle - cameraAngle), Math.cos(facingAngle - cameraAngle));
    view.plane.rotation.y = Math.max(-0.24, Math.min(0.24, delta * 0.38));
  }

  // ---------------------------------------------------------------- frame

  updateCamera(match, layout, dt) {
    if (layout.aiming) return;
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
        if (view.shadow) view.shadow.visible = false;
        continue;
      }
      // In first person you are inside this player's head; drawing them would
      // fill the screen with the back of their own shirt.
      if (layout.firstPerson && layout.eyePlayer && layout.eyePlayer.id === p.id) {
        view.group.visible = false;
        if (view.shadow) view.shadow.visible = false;
        continue;
      }
      view.group.visible = true;
      if (view.kind === 'sprite') {
        // Broadcast cameras put a 105 m pitch on screen at once. A restrained
        // impostor overscan keeps the generated silhouettes readable without
        // changing their calibrated height in close or first-person views.
        view.group.scale.setScalar(layout.firstPerson || layout.shooter ? 1 : 1.12);
      }
      if (view.shadow) {
        view.shadow.visible = true;
        view.shadow.position.copy(toThree(THREE, p.pos.x, p.pos.y, 0.025));
      }
      view.group.position.copy(toThree(THREE, p.pos.x, p.pos.y, 0));
      if (view.kind === 'sprite') this.faceSpriteToCamera(view, p);
      else if (view.kind === 'humanoid') this.turnHumanoid(view, p, opts.animationDt ?? opts.dt ?? 0);
      else {
        // Face the way they are running.
        const f = p.facing;
        view.group.rotation.y = Math.atan2(f.x, -f.y) - Math.PI / 2;
      }
      this.animate(view, p, opts.animationDt ?? opts.dt ?? 0);
      view.group.position.y += view.bob;
      const controlled = opts.controlledIds && opts.controlledIds.has(p.id);
      view.ring.visible = Boolean(controlled);
      if (controlled) view.ring.material.color.set(opts.controlledColours?.get(p.id) || (p.human === 1 ? 0x00e5ff : 0xffe600));
    }

    const b = match.ball;
    this.ballMesh.position.copy(toThree(THREE, b.pos.x, b.pos.y, Math.max(0.22, b.z + 0.22)));
    this.ballMesh.rotation.x += Math.hypot(b.vel.x, b.vel.y) * (opts.animationDt ?? opts.dt ?? 0) / 0.22;
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

// The generated cutouts use a neutral navy kit. Recolour only the blue kit
// pixels, preserving fur, skin, eyes, boots, and the baked studio shading.
const PLAYER_SPRITE_VERTEX = `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const PLAYER_SPRITE_FRAGMENT = `
  uniform sampler2D mapIdle;
  uniform sampler2D mapRun;
  uniform vec3 primary;
  uniform vec3 secondary;
  uniform vec3 accent;
  uniform float runMix;
  varying vec2 vUv;

  vec4 sprite(vec2 uv) {
    return mix(texture2D(mapIdle, uv), texture2D(mapRun, uv), runMix);
  }

  vec3 tint(vec3 source, vec3 target) {
    float luminance = dot(source, vec3(0.2126, 0.7152, 0.0722));
    return target * mix(0.55, 1.12, luminance);
  }

  void main() {
    vec4 texel = sprite(vUv);
    vec2 px = vec2(0.0018, 0.0012);
    float neighbour = max(max(sprite(vUv + vec2(px.x, 0.0)).a, sprite(vUv - vec2(px.x, 0.0)).a), max(sprite(vUv + vec2(0.0, px.y)).a, sprite(vUv - vec2(0.0, px.y)).a));
    float edge = max(0.0, neighbour - texel.a);
    if (texel.a < 0.06) {
      if (edge < 0.08) discard;
      gl_FragColor = vec4(accent, edge * 0.78);
      return;
    }
    float blue = smoothstep(0.055, 0.22, texel.b - max(texel.r, texel.g) * 0.72);
    float shirt = blue * smoothstep(0.43, 0.53, vUv.y) * (1.0 - smoothstep(0.74, 0.84, vUv.y));
    float shorts = blue * smoothstep(0.22, 0.31, vUv.y) * (1.0 - smoothstep(0.44, 0.52, vUv.y));
    float socks = blue * smoothstep(0.035, 0.10, vUv.y) * (1.0 - smoothstep(0.25, 0.34, vUv.y));
    vec3 color = texel.rgb;
    color = mix(color, tint(color, primary), shirt + shorts);
    color = mix(color, tint(color, secondary), socks);
    gl_FragColor = vec4(color, texel.a);
  }
`;

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
