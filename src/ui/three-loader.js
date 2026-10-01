// Loads three.js from a CDN at runtime. The game must keep working with no
// network (that is the point of serving it off your own machine), so this
// resolves to null on any failure and the caller falls back to the canvas
// renderer instead of breaking.

const CDN = 'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js';
const TIMEOUT_MS = 6000;

let pending = null;

export function loadThree({ url = CDN, timeout = TIMEOUT_MS } = {}) {
  if (pending) return pending;
  pending = loadScript(url, timeout).then((ok) => (ok ? window.THREE || null : null));
  return pending;
}

// Appends a classic <script> and resolves true once it has run, or false on
// error, timeout or when there is no document.
export function loadScript(url, timeout = TIMEOUT_MS) {
  return new Promise((resolve) => {
    if (typeof document === 'undefined') return resolve(false);
    if (url === CDN && window.THREE) return resolve(true);
    const script = document.createElement('script');
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(false), timeout);
    script.src = url;
    // Addons must run after three.js and in the order they are requested.
    script.async = false;
    script.onload = () => finish(true);
    script.onerror = () => finish(false);
    document.head.appendChild(script);
  });
}
