// Loads three.js from a CDN at runtime. The game must keep working with no
// network (that is the point of serving it off your own machine), so this
// resolves to null on any failure and the caller falls back to the canvas
// renderer instead of breaking.

const CDN = 'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js';
const TIMEOUT_MS = 6000;

let pending = null;

export function loadThree({ url = CDN, timeout = TIMEOUT_MS } = {}) {
  if (pending) return pending;
  pending = new Promise((resolve) => {
    if (typeof document === 'undefined') return resolve(null);
    if (window.THREE) return resolve(window.THREE);
    const script = document.createElement('script');
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeout);
    script.src = url;
    script.async = true;
    script.onload = () => finish(window.THREE || null);
    script.onerror = () => finish(null);
    document.head.appendChild(script);
  });
  return pending;
}
