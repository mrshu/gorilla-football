import { CHARACTERS } from '../data/characters.js';

const shapes = new Set(CHARACTERS.map((character) => character.look.shape));

// Request only characters actually on the pitch. Each pair is shared by all
// players of that species, including players on opposite teams with kit tint.
export class PlayerSpriteLibrary {
  constructor(THREE, { createImage = () => new Image(), timeout = 12000 } = {}) {
    this.THREE = THREE;
    this.createImage = createImage;
    this.timeout = timeout;
    this.textures = new Map();
    this.requests = new Map();
    this.disposed = false;
  }

  load(shape) {
    if (this.disposed || !shapes.has(shape)) return Promise.resolve(null);
    if (this.requests.has(shape)) return this.requests.get(shape);
    const request = Promise.all([
      this.loadTexture(`public/assets/players/${shape}-idle.png`),
      this.loadTexture(`public/assets/players/${shape}-run.png`),
    ]).then(([idle, run]) => {
      if (this.disposed || !idle) {
        idle?.dispose();
        run?.dispose();
        return null;
      }
      // A missing running pose still leaves the chosen character visible;
      // its normal gait deformation continues using the idle artwork.
      const pair = { idle, run: run || idle };
      this.textures.set(shape, pair);
      return pair;
    });
    this.requests.set(shape, request);
    return request;
  }

  loadTexture(path) {
    return new Promise((resolve) => {
      const image = this.createImage();
      let timer;
      const finish = (texture) => {
        clearTimeout(timer);
        image.onload = image.onerror = null;
        resolve(texture);
      };
      image.onload = () => {
        const texture = new this.THREE.Texture(image);
        texture.needsUpdate = true;
        texture.minFilter = texture.magFilter = this.THREE.LinearFilter;
        // These portrait textures are not power-of-two. Linear filtering
        // keeps them legal in WebGL 1 without Three resizing the artwork.
        texture.generateMipmaps = false;
        if (this.THREE.sRGBEncoding !== undefined) texture.encoding = this.THREE.sRGBEncoding;
        finish(texture);
      };
      image.onerror = () => finish(null);
      timer = setTimeout(() => finish(null), this.timeout);
      image.src = path;
    });
  }

  dispose() {
    this.disposed = true;
    for (const texture of new Set([...this.textures.values()].flatMap(({ idle, run }) => [idle, run]))) {
      texture.dispose();
    }
    this.textures.clear();
  }
}
