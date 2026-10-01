// Builds public/models/*.glb from the Quaternius CC0 packs (see
// public/models/CREDITS.md). Not part of the game: it needs
// `npm i @gltf-transform/core@4 @gltf-transform/functions@4
// @gltf-transform/extensions@4 sharp` in a scratch folder.
//
//   node build-footballer-assets.mjs <src> <out>
//
// <src> must contain:
//   lab/base/            Universal Base Characters "Godot - UE" glTFs, the
//                        "Rigged to Head Bone" hairstyles, and their textures
//   ual1_ue.glb          UAL1 "Unreal Engine/AL_Standard.fbx" run through
//                        FBX2glTF --binary (keeps the Unreal bone names)
//   lab/UAL2_Standard.glb
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { prune, dedup, textureCompress } from '@gltf-transform/functions';
import sharp from 'sharp';
import fs from 'fs';
const S = process.argv[2], OUT = process.argv[3];
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
fs.mkdirSync(OUT, { recursive: true });
const BASE = `${S}/lab/base`;

async function shrink(doc, size) {
  await doc.transform(textureCompress({ encoder: sharp, targetFormat: 'jpeg', quality: 86, resize: [size, size] }));
}

// Body
const body = await io.read(`${BASE}/Superhero_Male_FullBody.gltf`);
await body.transform(dedup(), prune());
await shrink(body, 1024);
await io.write(`${OUT}/footballer.glb`, body);
const restPelvis = body.getRoot().listNodes().find(n => n.getName() === 'pelvis').getTranslation()[2];

// Hair pieces, rigged to the head bone
for (const name of ['Hair_Buzzed', 'Hair_SimpleParted', 'Hair_Beard']) {
  const d = await io.read(`${BASE}/${name}.gltf`);
  await d.transform(dedup(), prune());
  await shrink(d, 512);
  await io.write(`${OUT}/${name.toLowerCase()}.glb`, d);
}

// Animation clips: drop meshes, keep chosen clips, rescale hip translation
// into the body's units and drop every other translation/scale channel.
async function clips(path, keep) {
  const d = await io.read(path);
  const root = d.getRoot();
  const pelvis = root.listNodes().find(n => n.getName() === 'pelvis');
  const k = restPelvis / pelvis.getTranslation()[2];
  for (const n of root.listNodes()) { if (n.getMesh()) n.setMesh(null); if (n.getSkin()) n.setSkin(null); }
  for (const a of root.listAnimations()) {
    const name = a.getName().replace(/^.*\|/, '');
    // Accessors can be shared between clips, so leave them to prune().
    if (!keep.includes(name)) { for (const c of a.listChannels()) c.dispose(); for (const sm of a.listSamplers()) sm.dispose(); a.dispose(); continue; }
    a.setName(name);
    for (const c of a.listChannels()) {
      const path = c.getTargetPath(), node = c.getTargetNode();
      if (path === 'scale' || (path === 'translation' && node !== pelvis)) { c.getSampler().dispose(); c.dispose(); continue; }
      if (path === 'translation') {
        const out = c.getSampler().getOutput();
        const arr = out.getArray().slice().map(v => v * k);
        out.setArray(arr);
      }
    }
  }
  await d.transform(prune());
  return d;
}
const a1 = await clips(`${S}/ual1_ue.glb`, ['Idle_Loop', 'Jog_Fwd_Loop', 'Sprint_Loop', 'Walk_Loop']);
await io.write(`${OUT}/anim-locomotion.glb`, a1);
const a2 = await clips(`${S}/lab/UAL2_Standard.glb`, ['Slide_Start', 'Slide_Loop', 'Slide_Exit']);
await io.write(`${OUT}/anim-slide.glb`, a2);
console.log('restPelvis', restPelvis);
