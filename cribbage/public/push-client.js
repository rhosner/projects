// Browser side of Web Push: service worker registration and subscriptions.

export const isIOS = () =>
  /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
export const isStandalone = () =>
  window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
export const pushSupported = () =>
  window.isSecureContext && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

/**
 * 'ready'       push can be turned on
 * 'ios-install' iPhone/iPad in a browser tab: must Add to Home Screen first
 * 'insecure'    page isn't on HTTPS
 * 'unsupported' browser has no Web Push
 */
export function pushAvailability() {
  if (pushSupported()) return 'ready';
  if (!window.isSecureContext) return 'insecure';
  if (isIOS() && !isStandalone()) return 'ios-install';
  return 'unsupported';
}

let registration;
export function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return null;
  registration ??= navigator.serviceWorker.register('/sw.js').catch(() => null);
  return registration;
}

function keyBytes(base64url) {
  const pad = '='.repeat((4 - (base64url.length % 4)) % 4);
  const raw = atob((base64url + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

const sameKey = (a, b) => a && a.byteLength === b.byteLength && new Uint8Array(a).every((x, i) => x === b[i]);

let serverKey;
async function getServerKey() {
  serverKey ??= fetch('/api/push/key').then((r) => r.json()).then((d) => keyBytes(d.publicKey));
  return serverKey;
}

/** Returns a PushSubscription, creating one if needed. Permission must already be granted. */
export async function ensureSubscription() {
  await registerServiceWorker();
  const reg = await navigator.serviceWorker.ready;
  const key = await getServerKey();
  let sub = await reg.pushManager.getSubscription();
  // A subscription made with a different server key (e.g. keys were rotated) can't be used.
  if (sub && !sameKey(sub.options?.applicationServerKey, key)) {
    await sub.unsubscribe();
    sub = null;
  }
  if (sub) return sub;
  // subscribe() talks to the browser vendor's push service; don't let a stall look like nothing happened.
  return Promise.race([
    reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('the push service didn’t respond. Try again in a moment')), 20_000)),
  ]);
}

export async function currentSubscription() {
  if (!pushSupported()) return null;
  await registerServiceWorker();
  const reg = await navigator.serviceWorker.getRegistration();
  return reg ? reg.pushManager.getSubscription() : null;
}
