// Species pieces ride the existing animated skeleton. Geometry is authored
// in metres, y-up and facing +z, then calibrated to each bone's bind frame.
export function attachCharacterRig(THREE, root, character) {
  root.updateMatrixWorld(true);
  const { shape, skin: skinColour, accent: accentColour, size } = character.look;
  const attachments = [];
  const attach = (boneName, name) => {
    const bone = root.getObjectByName(boneName);
    if (!bone) throw new Error(`character rig requires bone ${boneName}`);
    const group = new THREE.Group();
    group.name = name;
    // The imported neck/spine bones have tilted local axes. Cancel only the
    // rest rotation; all subsequent head turns and gait motion remain live.
    group.quaternion.copy(bone.getWorldQuaternion(new THREE.Quaternion())).invert();
    bone.add(group);
    attachments.push(group);
    return group;
  };
  const head = attach('Head', `character-${shape}-head`);
  const material = (colour, roughness = 0.85) => new THREE.MeshStandardMaterial({ color: colour, roughness, metalness: 0 });
  const skin = material(skinColour);
  const accent = material(accentColour);
  const dark = material('#161b22');
  const white = material('#f5f4e9');
  const fur = material(shape === 'yeti' ? skinColour : '#3a281d');
  const mesh = (parent, name, geometry, mat, x, y, z) => {
    const part = new THREE.Mesh(geometry, mat);
    part.name = name;
    part.position.set(x, y, z);
    part.castShadow = true;
    parent.add(part);
    return part;
  };
  const ball = (parent, name, mat, x, y, z, sx, sy = sx, sz = sx) => {
    const part = mesh(parent, name, new THREE.SphereGeometry(1, 12, 8), mat, x, y, z);
    part.scale.set(sx, sy, sz);
    return part;
  };
  const box = (name, mat, x, y, z, width, height, depth) =>
    mesh(head, name, new THREE.BoxGeometry(width, height, depth), mat, x, y, z);
  const eyes = (y = 0.14, z = 0.14, separation = 0.055) => {
    for (const side of [-1, 1]) {
      ball(head, `eye-${side}`, white, separation * side, y, z, 0.029, 0.022, 0.013);
      ball(head, `pupil-${side}`, dark, separation * side, y, z + 0.012, 0.012, 0.014, 0.008);
    }
  };
  const ears = (mat = skin) => {
    for (const side of [-1, 1]) ball(head, `ear-${side}`, mat, side * 0.145, 0.115, 0, 0.045, 0.057, 0.027);
  };

  if (shape === 'gorilla' || shape === 'yeti') {
    ball(head, `${shape}-fur-head`, fur, 0, 0.11, 0, 0.172, 0.172, 0.145);
    ball(head, `${shape}-face`, skin, 0, 0.105, 0.095, 0.117, 0.122, 0.073);
    ball(head, `${shape}-muzzle`, shape === 'yeti' ? accent : material('#a37b56'), 0, 0.025, 0.16, 0.10, 0.066, 0.062);
    box('nose', dark, 0, 0.059, 0.215, 0.066, 0.028, 0.014);
    box('mouth', dark, 0, 0.002, 0.217, 0.067, 0.012, 0.012);
    eyes(0.135, 0.165);
    for (const side of [-1, 1]) {
      const brow = box(`${shape}-brow-${side}`, fur, side * 0.056, 0.166, 0.173, 0.091, 0.032, 0.025);
      brow.rotation.z = side * 0.10;
    }
    ears(fur);
    if (shape === 'yeti') {
      for (const side of [-1, 1]) {
        ball(head, `yeti-tuft-${side}`, fur, side * 0.135, 0.055, -0.015, 0.071, 0.113, 0.060);
        const cuff = attach(`lowerarm_${side < 0 ? 'l' : 'r'}`, `yeti-forearm-fur-${side}`);
        const hand = root.getObjectByName(`hand_${side < 0 ? 'l' : 'r'}`);
        const offset = hand.getWorldPosition(new THREE.Vector3()).sub(cuff.parent.getWorldPosition(new THREE.Vector3())).multiplyScalar(0.48);
        ball(cuff, 'fur-cuff', fur, offset.x, offset.y, offset.z, 0.12, 0.075, 0.10);
      }
    }
  } else if (shape === 'tortoise') {
    ball(head, 'tortoise-head', skin, 0, 0.09, 0.025, 0.15, 0.125, 0.17);
    ball(head, 'tortoise-muzzle', skin, 0, 0.039, 0.145, 0.111, 0.061, 0.098);
    eyes(0.134, 0.160, 0.073);
    box('tortoise-mouth', dark, 0, 0.022, 0.24, 0.079, 0.01, 0.01);
    const shell = attach('spine_03', 'tortoise-shell');
    ball(shell, 'shell-dome', accent, 0, -0.02, -0.19, 0.32, 0.39, 0.20);
    const rim = mesh(shell, 'shell-rim', new THREE.TorusGeometry(0.30, 0.028, 6, 18), material('#bba575'), 0, -0.02, -0.18);
    rim.scale.y = 1.22;
    // Raised scutes make the shell read from both the back and side.
    for (const [x, y] of [[0, 0], [-0.13, 0.08], [0.13, 0.08], [0, 0.20], [0, -0.20]]) {
      ball(shell, 'shell-scute', material('#6d563a'), x, y - 0.02, -0.36, 0.105, 0.10, 0.037);
    }
  } else if (shape === 'rocket') {
    ball(head, 'rocket-helmet', skin, 0, 0.11, 0, 0.17, 0.175, 0.15);
    ball(head, 'rocket-visor', dark, 0, 0.12, 0.113, 0.143, 0.077, 0.055);
    box('rocket-visor-light', accent, 0, 0.123, 0.169, 0.21, 0.017, 0.008);
    for (const side of [-1, 1]) {
      ball(head, `rocket-earpiece-${side}`, accent, side * 0.165, 0.12, 0, 0.029, 0.066, 0.07);
    }
    box('rocket-helmet-stripe', accent, 0, 0.261, 0.011, 0.035, 0.012, 0.15);
  } else if (shape === 'penguin') {
    ball(head, 'penguin-head', skin, 0, 0.11, 0, 0.15, 0.17, 0.14);
    for (const side of [-1, 1]) ball(head, `penguin-mask-${side}`, white, side * 0.073, 0.08, 0.088, 0.074, 0.132, 0.056);
    eyes(0.156, 0.143, 0.056);
    const beak = mesh(head, 'penguin-beak', new THREE.ConeGeometry(0.070, 0.19, 4), accent, 0, 0.071, 0.197);
    beak.rotation.x = Math.PI / 2;
    beak.scale.z = 0.48;
  } else {
    ball(head, `${shape}-head`, skin, 0, 0.105, 0, 0.135, 0.154, 0.13);
    ball(head, 'nose', skin, 0, 0.088, 0.132, 0.029, 0.035, 0.047);
    eyes(0.149, 0.127);
    ears();
    if (shape === 'wizard') {
      const brim = mesh(head, 'wizard-hat-brim', new THREE.CylinderGeometry(0.225, 0.225, 0.028, 16), accent, 0, 0.241, 0);
      brim.scale.z = 0.82;
      const hat = mesh(head, 'wizard-hat', new THREE.ConeGeometry(0.15, 0.34, 16), accent, 0, 0.40, 0);
      hat.rotation.z = -0.14;
      const beard = mesh(head, 'wizard-beard', new THREE.ConeGeometry(0.095, 0.23, 10), white, 0, -0.019, 0.107);
      beard.rotation.z = Math.PI;
    } else {
      ball(head, 'plumber-cap', accent, 0, 0.243, -0.012, 0.155, 0.069, 0.146);
      box('plumber-cap-brim', accent, 0, 0.218, 0.133, 0.24, 0.025, 0.14);
      for (const side of [-1, 1]) ball(head, `plumber-moustache-${side}`, dark, side * 0.037, 0.048, 0.134, 0.052, 0.023, 0.026);
    }
  }

  // Scale the complete animated body and its attachments together. Separate
  // width/depth proportions preserve the species silhouette without changing
  // the skeleton, kit regions or animation retargeting.
  const breadth = { gorilla: 1.17, tortoise: 1.07, wizard: 0.94, rocket: 0.95, penguin: 0.94, yeti: 1.14, plumber: 1 }[shape] || 1;
  const height = 1 + (size - 1) * 0.32;
  const proportions = { x: breadth * height, y: height, z: height * (shape === 'gorilla' || shape === 'yeti' ? 1.08 : 1) };
  root.scale.set(proportions.x, proportions.y, proportions.z);
  return { shape, head, attachments, proportions };
}
