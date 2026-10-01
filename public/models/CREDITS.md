# Footballer models

All files in this folder are derived from packs by Quaternius, released under
CC0 1.0 (public domain): <https://creativecommons.org/publicdomain/zero/1.0/>.

| File | Source |
|---|---|
| `footballer.glb` | Universal Base Characters (Standard), `Superhero_Male_FullBody` |
| `hair_*.glb` | Universal Base Characters, hairstyles rigged to the head bone |
| `anim-locomotion.glb` | Universal Animation Library (Standard), Unreal FBX: `Idle_Loop`, `Walk_Loop`, `Jog_Fwd_Loop`, `Sprint_Loop` |
| `anim-slide.glb` | Universal Animation Library 2 (Standard): `Slide_Start`, `Slide_Loop`, `Slide_Exit` |

- <https://quaternius.itch.io/universal-base-characters>
- <https://quaternius.com/packs/universalanimationlibrary.html>
- <https://opengameart.org/content/universal-animation-library-2>

`scripts/build-footballer-assets.mjs` produced these files: it resizes the
textures to JPEG, keeps only the clips above, and rescales the hip
translation of the clips into the body's units (the UAL FBX rig is authored
in centimetres). The UAL FBX was converted with Godot's FBX2glTF first.
