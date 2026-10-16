import { watchEvent, watchPhotos, addPhotoDoc, deletePhotoDoc, PHOTO_RETENTION_DAYS } from '../data.js';
import { esc, $, toast } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { formatDay } from '../lib/time.js';
import { shrink, FULL, THUMB, uploadVariant, deletePhotoFiles, photoUrl, forgetPhoto } from '../lib/photos.js';

const newPhotoId = () => crypto.randomUUID().replace(/-/g, '');

export function photosView(root, ctx, eventId) {
  let event = null;
  let photos = [];
  let busy = false;
  let lightbox = null; // photo id being viewed
  const unsubs = [];

  root.innerHTML = `
    <section class="bar">
      <a class="btn ghost" href="#/">${icon('back')} Events</a>
      <a class="btn ghost" href="#/event/${esc(eventId)}">${icon('edit')} Event details</a>
    </section>
    <h1 id="title" style="margin-bottom:4px">${icon('camera', 'lg')} Photos</h1>
    <p id="sub" class="muted" style="margin-top:0"></p>
    <section class="card">
      <label class="btn primary" id="addBtn">${icon('camera')} <span id="addLbl">Add photos</span>
        <input type="file" id="file" accept="image/*" multiple hidden />
      </label>
      <p class="muted" id="status" aria-live="polite"></p>
      <p class="muted">Photos are deleted automatically ${PHOTO_RETENTION_DAYS} days after upload.</p>
    </section>
    <section id="grid" class="photo-grid" aria-live="polite"></section>
    <div id="lb" class="lightbox" hidden></div>`;

  const grid = $('#grid', root);
  const lb = $('#lb', root);

  function renderHeader() {
    $('#sub', root).textContent = event ? `${event.name} · ${formatDay(event.date)}` : '';
  }

  function renderGrid() {
    if (!photos.length) {
      grid.innerHTML = `<div class="card empty">${icon('camera', 'lg')}<p>No photos yet.</p></div>`;
      return;
    }
    grid.innerHTML = photos
      .map(
        (p) => `<button type="button" class="ph" data-id="${esc(p.id)}" aria-label="Open photo by ${esc(p.uploadedByName || 'staff')}">
          <img alt="" width="${p.width || ''}" height="${p.height || ''}" /></button>`,
      )
      .join('');
    grid.querySelectorAll('.ph').forEach((b) => {
      const img = b.querySelector('img');
      photoUrl(eventId, b.dataset.id, 'thumb').then(
        (u) => (img.src = u),
        () => b.classList.add('broken'),
      );
    });
  }

  function renderLightbox() {
    const p = photos.find((x) => x.id === lightbox);
    if (!p) {
      lightbox = null;
      lb.hidden = true;
      lb.innerHTML = '';
      return;
    }
    const i = photos.indexOf(p);
    lb.hidden = false;
    lb.innerHTML = `
      <div class="lb-bar">
        <span class="muted">${i + 1} / ${photos.length} · ${esc(p.uploadedByName || '')}</span>
        <span class="lb-actions">
          <button type="button" class="ibadge del" id="lbDel" aria-label="Delete photo" title="Delete">${icon('trash')}</button>
          <button type="button" class="ibadge" id="lbClose" aria-label="Close" title="Close">${icon('x')}</button>
        </span>
      </div>
      <div class="lb-stage">
        <button type="button" class="lb-nav prev" id="lbPrev" aria-label="Previous" ${i === 0 ? 'disabled' : ''}>${icon('back')}</button>
        <img id="lbImg" alt="Event photo" />
        <button type="button" class="lb-nav next" id="lbNext" aria-label="Next" ${i === photos.length - 1 ? 'disabled' : ''}>${icon('chevron')}</button>
      </div>`;
    photoUrl(eventId, p.id, 'full').then(
      (u) => {
        const img = $('#lbImg', lb);
        if (img && lightbox === p.id) img.src = u;
      },
      () => toast('Could not load photo.'),
    );
    $('#lbClose', lb).onclick = () => ((lightbox = null), renderLightbox());
    $('#lbPrev', lb).onclick = () => ((lightbox = photos[i - 1].id), renderLightbox());
    $('#lbNext', lb).onclick = () => ((lightbox = photos[i + 1].id), renderLightbox());
    $('#lbDel', lb).onclick = async () => {
      if (!confirm('Delete this photo? This cannot be undone.')) return;
      try {
        await deletePhotoFiles(eventId, p.id);
        await deletePhotoDoc(eventId, p.id);
        forgetPhoto(p.id);
        lightbox = photos[i + 1]?.id || photos[i - 1]?.id || null;
        renderLightbox();
        toast('Photo deleted');
      } catch {
        toast('Could not delete. Try again.');
      }
    };
  }

  async function upload(files) {
    if (!files.length || busy) return;
    if (!navigator.onLine) return toast('You are offline. Connect to upload photos.');
    busy = true;
    $('#addBtn', root).classList.add('disabled');
    const status = $('#status', root);
    let ok = 0;
    let failed = 0;
    for (const [n, file] of files.entries()) {
      status.textContent = `Uploading ${n + 1} of ${files.length}…`;
      try {
        const id = newPhotoId();
        const full = await shrink(file, FULL);
        const thumb = await shrink(file, THUMB);
        await uploadVariant(eventId, id, 'full', full.blob);
        await uploadVariant(eventId, id, 'thumb', thumb.blob);
        await addPhotoDoc(eventId, id, {
          uploadedBy: ctx.user.uid,
          uploadedByName: ctx.name || '',
          width: full.width,
          height: full.height,
        });
        ok++;
      } catch (e) {
        console.error('photo upload failed', e);
        failed++;
      }
    }
    busy = false;
    $('#addBtn', root).classList.remove('disabled');
    status.textContent = failed ? `${ok} uploaded, ${failed} failed.` : '';
    toast(failed ? `${failed} photo(s) failed to upload` : `Uploaded ${ok} photo${ok === 1 ? '' : 's'}`);
  }

  $('#file', root).onchange = (ev) => {
    const files = [...ev.target.files];
    ev.target.value = '';
    upload(files);
  };
  grid.onclick = (ev) => {
    const b = ev.target.closest('[data-id]');
    if (!b) return;
    lightbox = b.dataset.id;
    renderLightbox();
  };
  const onKey = (ev) => {
    if (lb.hidden) return;
    const i = photos.findIndex((x) => x.id === lightbox);
    if (ev.key === 'Escape') (lightbox = null), renderLightbox();
    else if (ev.key === 'ArrowLeft' && i > 0) (lightbox = photos[i - 1].id), renderLightbox();
    else if (ev.key === 'ArrowRight' && i < photos.length - 1) (lightbox = photos[i + 1].id), renderLightbox();
  };
  document.addEventListener('keydown', onKey);

  unsubs.push(
    watchEvent(eventId, (e) => {
      event = e;
      renderHeader();
    }),
    watchPhotos(eventId, (rows) => {
      photos = rows;
      renderGrid();
      if (lightbox) renderLightbox();
    }),
  );

  return () => {
    unsubs.forEach((u) => u());
    document.removeEventListener('keydown', onKey);
  };
}
