import { auth } from '../firebase.js';

export const FULL = { max: 1600, quality: 0.8 };
export const THUMB = { max: 320, quality: 0.7 };

/** Largest side after scaling `w`x`h` down to fit `max` (never upscales). */
export function fitSize(w, h, max) {
  const s = Math.min(1, max / Math.max(w, h));
  return { width: Math.max(1, Math.round(w * s)), height: Math.max(1, Math.round(h * s)) };
}

/** Decode an image File (honouring EXIF rotation) and re-encode as a smaller JPEG. */
export async function shrink(file, { max, quality }) {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const { width, height } = fitSize(bmp.width, bmp.height, max);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(bmp, 0, 0, width, height);
  bmp.close?.();
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
  if (!blob) throw new Error('Could not encode image');
  return { blob, width, height };
}

async function api(path, init = {}) {
  const user = auth.currentUser;
  if (!user) throw new Error('Not signed in');
  const token = await user.getIdToken();
  const res = await fetch(`/api/photos/${path}`, {
    ...init,
    headers: { ...init.headers, Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
  return res;
}

export const uploadVariant = (eventId, photoId, variant, blob) =>
  api(`${eventId}/${photoId}?v=${variant}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'image/jpeg' },
    body: blob,
  });

export const deletePhotoFiles = (eventId, photoId) => api(`${eventId}/${photoId}`, { method: 'DELETE' });

// Images need the Authorization header, so they are fetched and shown via object URLs.
const urls = new Map();
export function photoUrl(eventId, photoId, variant) {
  const key = `${photoId}:${variant}`;
  if (!urls.has(key)) {
    urls.set(
      key,
      api(`${eventId}/${photoId}?v=${variant}`)
        .then((r) => r.blob())
        .then((b) => URL.createObjectURL(b))
        .catch((e) => (urls.delete(key), Promise.reject(e))),
    );
  }
  return urls.get(key);
}

export function forgetPhoto(photoId) {
  for (const v of ['full', 'thumb']) {
    const key = `${photoId}:${v}`;
    urls.get(key)?.then((u) => URL.revokeObjectURL(u), () => {});
    urls.delete(key);
  }
}
