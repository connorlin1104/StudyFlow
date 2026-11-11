import { currentUser, storage } from './firebase.js';
import { esc, toast } from './utils.js';

let formAttachments = []; // { id, name, type, localUrl, url, storagePath, uploading, error }
// The homework modal replaces the whole list when it opens; an imported `let`
// can't be assigned from another module, so it goes through this.
function setFormAttachments(list) { formAttachments = list; }

/* =============================================================================
   ATTACHMENTS
   ============================================================================= */
function isImageType(type) { return type && type.startsWith('image/'); }

function fileIcon(type) {
  if (!type) return '📎';
  if (type.includes('pdf'))          return '📄';
  if (type.includes('word') || type.includes('doc')) return '📝';
  if (type.includes('sheet') || type.includes('excel') || type.includes('xls')) return '📊';
  if (type.includes('presentation') || type.includes('ppt')) return '📑';
  if (type.includes('video'))        return '🎬';
  if (type.includes('zip') || type.includes('compressed')) return '🗜️';
  return '📎';
}

function renderFormAttachments() {
  const container = document.getElementById('form-attachments');
  if (!container) return;
  container.classList.toggle('hidden', formAttachments.length === 0);
  container.innerHTML = '';
  formAttachments.forEach(att => {
    const item = document.createElement('div');
    item.className = 'form-attach-item';
    if (isImageType(att.type)) {
      if (att.uploading) {
        item.innerHTML = `<div class="form-attach-thumb form-attach-thumb--loading"><span class="spinner-sm"></span></div>`;
      } else {
        item.innerHTML = `<img class="form-attach-thumb" src="${esc(att.localUrl || att.url)}" alt="${esc(att.name)}">`;
      }
    } else {
      item.innerHTML = `<div class="form-attach-file">${fileIcon(att.type)}<span class="form-attach-file-name">${esc(att.name)}</span>${att.uploading ? '<span class="spinner-sm"></span>' : ''}</div>`;
    }
    const rm = document.createElement('button');
    rm.type = 'button'; rm.className = 'form-attach-remove'; rm.innerHTML = '&times;'; rm.title = 'Remove';
    rm.addEventListener('click', () => removeFormAttachment(att.id));
    item.appendChild(rm);
    container.appendChild(item);
  });
}

async function removeFormAttachment(id) {
  const idx = formAttachments.findIndex(a => a.id === id);
  if (idx === -1) return;
  const att = formAttachments.splice(idx, 1)[0];
  renderFormAttachments();
  if (att.localUrl) URL.revokeObjectURL(att.localUrl);
  if (att.storagePath && !att.uploading) {
    try { await storage.ref(att.storagePath).delete(); } catch (_) {}
  }
}

function handleAttachFiles(files) {
  if (!currentUser || !files || !files.length) return;
  Array.from(files).forEach(file => {
    const id = `att-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const localUrl = isImageType(file.type) ? URL.createObjectURL(file) : null;
    const att = { id, name: file.name, type: file.type, localUrl, url: null, storagePath: null, uploading: true, error: false, _promise: null };
    formAttachments.push(att);
    renderFormAttachments();
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
    const storagePath = `users/${currentUser.uid}/hw-attachments/${id}-${safeName}`;
    att._promise = storage.ref(storagePath).put(file)
      .then(snap => snap.ref.getDownloadURL())
      .then(url => {
          if (formAttachments.includes(att)) { att.url = url; att.storagePath = storagePath; att.uploading = false; }
        renderFormAttachments();
      })
      .catch(() => {
        if (formAttachments.includes(att)) { att.uploading = false; att.error = true; }
        renderFormAttachments();
        toast(`Failed to upload "${file.name}"`, 'error');
      });
  });
}

function openLightbox(url) {
  document.getElementById('lightbox-img').src = url;
  document.getElementById('lightbox').classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}
function closeLightbox() {
  document.getElementById('lightbox').classList.add('hidden');
  document.getElementById('lightbox-img').src = '';
  document.body.style.overflow = '';
}

export { closeLightbox, fileIcon, formAttachments, handleAttachFiles, isImageType, openLightbox, renderFormAttachments, setFormAttachments };
