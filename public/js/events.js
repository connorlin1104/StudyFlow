import { auth } from './firebase.js';
import { api } from './api.js';
import { selKey, splitKey, state } from './state.js';
import { clearSelection, handleSelectClick, sel, selectionKeys } from './selection.js';
import { history } from './history.js';
import { applyPrefs, prefs } from './prefs.js';
import { getNextAvailableColor } from './constants.js';
import { toast } from './utils.js';
import { renderTabBar } from './render.js';
import { openContextMenu } from './contextmenu.js';
import { closeLightbox, handleAttachFiles, openLightbox } from './attachments.js';
import { closeGroupForm, closeSettings, openGroupForm, openSettings, populateSettingsTabSelect, renderPrefsPage, renderSettingsClassList, renderSettingsTabsList, resetClassForm, selectSwatch, startEditClass, switchSettingsPage, updateSettingsLabels } from './settings.js';
import { closeHwModal, openHwEditModal, openHwModal } from './hw-modal.js';
import { handleAddHomework, handleAddTab, handleClassFormSubmit, handleDeleteClass, handleDeleteHw, handleDeleteTab, handleMarkComplete } from './handlers.js';
import { downloadSchedule, loadSchedule } from './transfer.js';
import { applyCollegeTemplate, applyPersonalTemplate, applyStudentTemplate, applyWorkTemplate } from './templates.js';
import { subscribeToNotifications, unsubscribeFromNotifications } from './notifications.js';
import { closePalette, wirePalette } from './palette.js';
import { closeHelp, wireShortcuts } from './shortcuts.js';

/* =============================================================================
   WIRE EVENTS
   ============================================================================= */
function buildTimePickerOptions() {
  const hourList = document.getElementById('hw-hour-list');
  for (let h = 1; h <= 12; h++) {
    const opt = document.createElement('option'); opt.value = String(h); hourList.appendChild(opt);
  }
  const minList = document.getElementById('hw-min-list');
  for (let m = 0; m <= 59; m++) {
    const opt = document.createElement('option'); opt.value = String(m).padStart(2, '0'); minList.appendChild(opt);
  }
  document.getElementById('hw-minute').addEventListener('blur', e => {
    const v = e.target.value.trim();
    if (v !== '' && !isNaN(v)) e.target.value = String(parseInt(v)).padStart(2, '0');
  });
}

function wireEvents() {
  buildTimePickerOptions();
  document.getElementById('add-hw-btn').addEventListener('click', () => openHwModal());
  document.getElementById('settings-btn').addEventListener('click', () => openSettings('account'));
  document.getElementById('empty-settings-btn').addEventListener('click', () => openSettings('tabs'));
  document.getElementById('empty-template-btn').addEventListener('click', () => openSettings('templates'));
  document.getElementById('empty-add-group-btn').addEventListener('click', () => {
    populateSettingsTabSelect(state.activeTabId);
    resetClassForm();
    openGroupForm();
  });
  document.getElementById('user-avatar').addEventListener('click', () => openSettings('account'));

  document.getElementById('undo-btn').addEventListener('click', () => history.undo());
  document.getElementById('redo-btn').addEventListener('click', () => history.redo());

  // Clicking away from the board drops the selection — but not onto the context
  // menu or the selection bar, both of which are there to act on it.
  document.addEventListener('click', e => {
    if (!sel.ids.size) return;
    if (e.target.closest('#classes-container, #context-menu, #selection-bar, .modal')) return;
    clearSelection();
  });
  document.getElementById('selection-clear').addEventListener('click', clearSelection);
  document.getElementById('selection-actions').addEventListener('click', e => {
    // Same menu the right-click gives, anchored to the bar
    const keys = selectionKeys();
    if (!keys.length) return;
    const [type, id] = splitKey(keys[0]);
    const r = e.currentTarget.getBoundingClientRect();
    openContextMenu(r.left, r.top - 8, type === 'fd' ? 'folder' : type === 'cls' ? 'class' : 'hw', id);
  });

  document.getElementById('hw-form').addEventListener('submit', handleAddHomework);
  document.getElementById('close-hw-modal').addEventListener('click', closeHwModal);
  document.getElementById('cancel-hw').addEventListener('click', closeHwModal);
  document.getElementById('hw-backdrop').addEventListener('click', closeHwModal);

  document.getElementById('hw-attach-btn').addEventListener('click', () => document.getElementById('hw-attach-input').click());
  document.getElementById('hw-attach-input').addEventListener('change', e => {
    handleAttachFiles(e.target.files);
    e.target.value = '';
  });
  document.getElementById('lightbox').addEventListener('click', e => {
    if (!e.target.closest('.lightbox-img')) closeLightbox();
  });
  document.getElementById('lightbox-close').addEventListener('click', closeLightbox);

  document.getElementById('close-settings').addEventListener('click', closeSettings);
  document.getElementById('settings-backdrop').addEventListener('click', closeSettings);
  document.getElementById('class-form').addEventListener('submit', handleClassFormSubmit);
  document.getElementById('cancel-edit-class').addEventListener('click', closeGroupForm);
  document.getElementById('add-group-btn').addEventListener('click', () => { resetClassForm(); openGroupForm(); });
  document.getElementById('close-group-form').addEventListener('click', closeGroupForm);
  document.getElementById('group-form-backdrop').addEventListener('click', closeGroupForm);
  document.getElementById('tab-form').addEventListener('submit', handleAddTab);
  document.getElementById('settings-tab-select').addEventListener('change', () => {
    renderSettingsClassList();
    updateSettingsLabels();
    if (!document.getElementById('edit-class-id').value) {
      selectSwatch(getNextAvailableColor(document.getElementById('settings-tab-select').value || 'classes'));
    }
  });

  document.querySelectorAll('.settings-nav-item').forEach(btn => {
    btn.addEventListener('click', () => { if (btn.dataset.page) switchSettingsPage(btn.dataset.page); });
  });

  // Account page
  document.getElementById('settings-sign-out-btn').addEventListener('click', () => auth.signOut());

  // Preferences page
  document.getElementById('theme-cards').addEventListener('click', e => {
    const card = e.target.closest('.theme-card');
    if (!card) return;
    prefs.set('theme', card.dataset.theme);
    applyPrefs();
    renderPrefsPage();
  });
  document.getElementById('pref-compact').addEventListener('change', e => {
    prefs.set('compact', e.target.checked);
    applyPrefs();
  });
  document.getElementById('pref-summary').addEventListener('change', e => {
    prefs.set('showSummary', e.target.checked);
    applyPrefs();
    const chev = document.getElementById('summary-drag-chevron');
    if (chev) chev.textContent = e.target.checked ? '‹' : '›';
  });

  // Summary panel drag-to-collapse
  (function() {
    const handle  = document.getElementById('summary-drag-handle');
    const panel   = document.querySelector('.summary-panel');
    const appBody = document.querySelector('.app-body');
    if (!handle || !panel || !appBody) return;

    function isMobile() { return window.innerWidth <= 820; }

    // ── Desktop drag (horizontal) ──────────────────────────────────────────────
    const D_EXPANDED = 340, D_COLLAPSED = 16, D_SNAP = 120;
    let dragging = false, startX = 0, startW = 0;

    handle.addEventListener('mousedown', e => {
      if (isMobile()) return;
      dragging = true; startX = e.clientX; startW = panel.offsetWidth;
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      e.preventDefault();
    });
    document.addEventListener('mousemove', e => {
      if (!dragging || isMobile()) return;
      const w = Math.max(D_COLLAPSED, Math.min(D_EXPANDED, startW - (e.clientX - startX)));
      appBody.style.gridTemplateColumns = `1fr ${w}px`;
    });
    document.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      document.body.style.cursor = ''; document.body.style.userSelect = '';
      const collapse = panel.offsetWidth < D_SNAP;
      appBody.style.gridTemplateColumns = '';
      setDesktopCollapsed(collapse);
    });
    handle.addEventListener('click', e => {
      if (isMobile() || Math.abs(e.clientX - startX) > 4) return;
      setDesktopCollapsed(!panel.classList.contains('summary-panel--collapsed'));
    });
    function setDesktopCollapsed(collapse) {
      panel.classList.toggle('summary-panel--collapsed', collapse);
      const chev = document.getElementById('summary-drag-chevron');
      if (chev) chev.textContent = collapse ? '›' : '‹';
      prefs.set('showSummary', !collapse);
      const tog = document.getElementById('pref-summary');
      if (tog) tog.checked = !collapse;
    }
    // Init desktop chevron
    const initChev = document.getElementById('summary-drag-chevron');
    if (initChev) initChev.textContent = panel.classList.contains('summary-panel--collapsed') ? '›' : '‹';

    // ── Mobile drag (vertical, 3-snap bottom sheet) ────────────────────────────
    function getSafeAreaBottom() {
      const el = document.createElement('div');
      el.style.cssText = 'position:fixed;bottom:0;height:env(safe-area-inset-bottom,0px);visibility:hidden;pointer-events:none';
      document.body.appendChild(el);
      const h = el.offsetHeight;
      el.remove();
      return h;
    }
    const M_SAFE_BOTTOM = navigator.standalone ? getSafeAreaBottom() : 0;
    const M_COLLAPSED = 36 + M_SAFE_BOTTOM;
    const M_NORMAL    = 240;
    const M_EXPANDED  = () => Math.round(window.innerHeight * 0.86);

    let mobileSnap = 'normal'; // 'collapsed' | 'normal' | 'expanded'
    let touching = false, touchStartY = 0, touchStartH = 0, touchStartTime = 0;

    function getCurrentMobileH() {
      const rows = appBody.style.gridTemplateRows;
      if (rows) { const m = rows.match(/(\d+(?:\.\d+)?)px/); if (m) return parseFloat(m[1]); }
      return mobileSnap === 'collapsed' ? M_COLLAPSED
           : mobileSnap === 'expanded'  ? M_EXPANDED()
           : M_NORMAL;
    }

    function snapMobileTo(snap, animate) {
      const h = snap === 'expanded' ? M_EXPANDED() : snap === 'normal' ? M_NORMAL : M_COLLAPSED;
      if (animate) {
        appBody.style.transition = 'grid-template-rows 230ms cubic-bezier(.4,0,.2,1)';
        setTimeout(() => { appBody.style.transition = ''; }, 240);
      }
      appBody.style.gridTemplateRows = `1fr ${h}px`;
      panel.classList.toggle('summary-panel--collapsed', snap === 'collapsed');
      mobileSnap = snap;
      prefs.set('mobileSummarySnap', snap);
      prefs.set('showSummary', snap !== 'collapsed');
      const tog = document.getElementById('pref-summary');
      if (tog) tog.checked = snap !== 'collapsed';
    }

    function nearestSnap(h) {
      const exp = M_EXPANDED();
      const dC = Math.abs(h - M_COLLAPSED), dN = Math.abs(h - M_NORMAL), dE = Math.abs(h - exp);
      const min = Math.min(dC, dN, dE);
      return min === dC ? 'collapsed' : min === dN ? 'normal' : 'expanded';
    }

    handle.addEventListener('touchstart', e => {
      if (!isMobile()) return;
      touching = true;
      touchStartY = e.touches[0].clientY;
      touchStartH = getCurrentMobileH();
      touchStartTime = Date.now();
      appBody.style.transition = '';
      e.preventDefault();
    }, { passive: false });

    document.addEventListener('touchmove', e => {
      if (!touching) return;
      const dy = touchStartY - e.touches[0].clientY;
      const h  = Math.max(M_COLLAPSED - 10, Math.min(M_EXPANDED() + 30, touchStartH + dy));
      appBody.style.gridTemplateRows = `1fr ${h}px`;
      panel.classList.toggle('summary-panel--collapsed', h < M_COLLAPSED + 16);
    }, { passive: true });

    document.addEventListener('touchend', e => {
      if (!touching) return;
      touching = false;
      const isTap = Date.now() - touchStartTime < 260
                 && Math.abs(touchStartY - (e.changedTouches[0]?.clientY ?? touchStartY)) < 12;
      if (isTap) {
        const next = mobileSnap === 'collapsed' ? 'normal'
                   : mobileSnap === 'expanded'  ? 'normal'
                   : 'collapsed';
        snapMobileTo(next, true);
      } else {
        snapMobileTo(nearestSnap(getCurrentMobileH()), true);
      }
    });

    // Init mobile snap state
    if (isMobile()) {
      const saved = prefs.get('mobileSummarySnap', prefs.get('showSummary', true) ? 'normal' : 'collapsed');
      mobileSnap = saved;
      snapMobileTo(saved, false);
    }
  })();
  document.getElementById('pref-notifications').addEventListener('change', e => {
    if (e.target.checked) subscribeToNotifications();
    else unsubscribeFromNotifications();
  });
  document.getElementById('pref-notify-before').addEventListener('change', async e => {
    const val = parseInt(e.target.value);
    prefs.set('notifyBefore', val);
    try { await api.notifications.setPrefs(val); }
    catch (_) {}
  });
  // TEST BUTTON — there is no endpoint to call any more; reminders are sent by a
  // GitHub Actions cron (notifier/send-reminders.js), which nothing in the
  // browser can trigger. To send a test push, run that workflow with mode=test.
  // document.getElementById('pref-notify-test-btn').addEventListener('click', async e => {
  //   const btn = e.currentTarget;
  //   btn.disabled = true;
  //   btn.textContent = 'Sending…';
  //   try {
  //     const result = await apiFetch('POST', '/api/notifications/test', {});
  //     toast('Test notification sent!', 'success');
  //     if (result?.debug) console.log('[notif test debug]', result.debug);
  //   } catch (err) {
  //     toast(`Test failed: ${err.message}`, 'error');
  //     console.error('[notif test error]', err);
  //   } finally {
  //     btn.disabled = false;
  //     btn.textContent = 'Send Test';
  //   }
  // });

  // Show/hide reminder group when deadline is set/cleared
  document.getElementById('hw-deadline').addEventListener('change', e => {
    document.getElementById('hw-reminder-group').classList.toggle('hidden', !e.target.value);
    if (!e.target.value) document.getElementById('hw-reminder').value = '';
  });

  // Schedule transfer
  document.getElementById('download-schedule-btn').addEventListener('click', downloadSchedule);
  document.getElementById('load-schedule-input').addEventListener('change', e => {
    const file = e.target.files[0];
    if (file) { loadSchedule(file); e.target.value = ''; }
  });

  document.getElementById('settings-tabs-list').addEventListener('click', e => {
    const deleteBtn = e.target.closest('.delete-tab-btn');
    const editBtn   = e.target.closest('.edit-tab-btn');
    if (deleteBtn) handleDeleteTab(deleteBtn.dataset.tabId);
    if (editBtn) {
      const tabId  = editBtn.dataset.tabId;
      const tab    = state.tabs.find(t => t.id === tabId);
      if (!tab) return;
      const item   = editBtn.closest('.settings-tab-item');
      const nameEl = item.querySelector('.settings-tab-name');
      const input  = document.createElement('input');
      input.type        = 'text';
      input.value       = tab.name;
      input.className   = 'inline-tab-rename';
      input.style.cssText = 'flex:1;font-size:.9rem;font-weight:600;border:1px solid var(--border);border-radius:4px;padding:2px 6px;background:var(--bg);color:var(--text);';
      nameEl.replaceWith(input);
      editBtn.textContent = 'Save';
      input.focus();
      input.select();

      // Clicking Save blurs the input first, and cancelling re-renders the list
      // (which also blurs it) — so guard against the commit running twice or
      // running at all after the user backed out.
      let settled = false;
      async function commitRename() {
        if (settled) return;
        settled = true;
        const newName = input.value.trim();
        if (newName && newName !== tab.name) {
          try {
            await api.tabs.update(tabId, { name: newName });
            tab.name = newName;
            renderTabBar();
            populateSettingsTabSelect(state.activeTabId);
            toast(`Renamed space to "${newName}"`, 'success');
          } catch (err) {
            toast(`Error: ${err.message}`, 'error');
          }
        }
        renderSettingsTabsList();
      }
      function cancelRename() {
        if (settled) return;
        settled = true;
        renderSettingsTabsList();
      }

      input.addEventListener('keydown', e => {
        if (e.key === 'Enter')  { e.preventDefault(); commitRename(); }
        if (e.key === 'Escape') { e.preventDefault(); cancelRename(); }
      });
      input.addEventListener('blur', commitRename);
      editBtn.addEventListener('click', e => { e.stopPropagation(); commitRename(); }, { once: true });
    }
  });

  document.getElementById('settings-classes-list').addEventListener('click', e => {
    const editBtn   = e.target.closest('.edit-class-btn');
    const deleteBtn = e.target.closest('.delete-class-btn');
    if (editBtn)   { const cls = state.classes.find(c => c.id === editBtn.dataset.classId);   if (cls) startEditClass(cls); }
    if (deleteBtn) { handleDeleteClass(deleteBtn.dataset.classId); }
  });

  // Main schedule — all delegated
  document.getElementById('classes-container').addEventListener('change', e => {
    const cb = e.target.closest('.hw-check');
    if (cb) handleMarkComplete(cb.dataset.hwId);
  });

  // Shift-click builds a selection, so don't let it also sweep a text highlight
  // across everything it touches.
  const board = document.getElementById('classes-container');
  board.addEventListener('mousedown', e => { if (e.shiftKey) e.preventDefault(); });

  // Custom context menu — desktop right-click
  board.addEventListener('contextmenu', e => {
    const hwItem   = e.target.closest('.hw-item');
    const folderEl = e.target.closest('.folder-header') && e.target.closest('.folder');
    const row      = e.target.closest('.class-row');
    if (hwItem)        { e.preventDefault(); openContextMenu(e.clientX, e.clientY, 'hw',     hwItem.dataset.hwId); }
    else if (folderEl) { e.preventDefault(); openContextMenu(e.clientX, e.clientY, 'folder', folderEl.dataset.folderId); }
    else if (row)      { e.preventDefault(); openContextMenu(e.clientX, e.clientY, 'class',  row.dataset.classId); }
  });

  // Custom context menu — touch long-press (excludes drag handles + controls)
  let lpTimer = null, lpXY = null;
  const cancelLP = () => { if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; } };
  board.addEventListener('pointerdown', e => {
    if (e.pointerType !== 'touch') return;
    if (e.target.closest('.hw-drag-handle, .class-drag-handle, .folder-drag-handle, button, a, input, label')) return;
    const hwItem   = e.target.closest('.hw-item');
    const folderEl = e.target.closest('.folder-header') && e.target.closest('.folder');
    const row      = e.target.closest('.class-row');
    const target = hwItem   ? ['hw',     hwItem.dataset.hwId]
                 : folderEl ? ['folder', folderEl.dataset.folderId]
                 : row      ? ['class',  row.dataset.classId]
                 : null;
    if (!target) return;
    lpXY = { x: e.clientX, y: e.clientY };
    lpTimer = setTimeout(() => {
      lpTimer = null;
      if (navigator.vibrate) navigator.vibrate(30);
      openContextMenu(lpXY.x, lpXY.y, target[0], target[1]);
      // Swallow the trailing click so the item doesn't also expand/collapse.
      const swallow = ev => { ev.preventDefault(); ev.stopPropagation(); document.removeEventListener('click', swallow, true); };
      document.addEventListener('click', swallow, true);
    }, 500);
  });
  board.addEventListener('pointermove', e => {
    if (lpTimer && lpXY && Math.hypot(e.clientX - lpXY.x, e.clientY - lpXY.y) > 8) cancelLP();
  });
  board.addEventListener('pointerup',     cancelLP);
  board.addEventListener('pointercancel', cancelLP);
  document.getElementById('classes-container').addEventListener('click', e => {
    // Ctrl/Cmd- and Shift-click build a selection instead of doing whatever the
    // click would normally do to the thing under the cursor.
    const mod = e.metaKey || e.ctrlKey;
    // A modifier held over a control still means the control: Ctrl-clicking a
    // checkbox marks the assignment done rather than half-selecting it.
    if ((mod || e.shiftKey) && !e.target.closest('button, a, input, label')) {
      const target = e.target.closest('.hw-item, .folder-header, .class-header');
      if (target) {
        e.preventDefault();
        const key = target.classList.contains('hw-item')     ? selKey('hw', target.dataset.hwId)
                  : target.classList.contains('folder-header') ? selKey('fd', target.closest('.folder').dataset.folderId)
                  :                                              selKey('cls', target.closest('.class-row').dataset.classId);
        handleSelectClick(key, mod, e.shiftKey);
        return;
      }
    }
    // Any other click on the board drops the selection, the way clicking away
    // from a selection does everywhere else.
    if (sel.ids.size && !e.target.closest('button, a, input, label')) clearSelection();

    const editBtn   = e.target.closest('.hw-edit-btn');
    const delBtn    = e.target.closest('.hw-delete');
    const addBtn    = e.target.closest('.class-add-hw-btn');
    const folderAdd = e.target.closest('.folder-add-btn');
    if (editBtn)   { openHwEditModal(editBtn.dataset.hwId); return; }
    if (delBtn)    { handleDeleteHw(delBtn.dataset.hwId);   return; }
    if (addBtn)    { openHwModal(addBtn.dataset.classId);   return; }
    if (folderAdd) {
      const folder = state.folders.find(f => f.id === folderAdd.dataset.folderId);
      if (folder) openHwModal(folder.classId, folder.id);
      return;
    }

    // Toggle a folder open/closed (click anywhere on its header)
    const folderHeader = e.target.closest('.folder-header');
    if (folderHeader && !e.target.closest('.folder-drag-handle')) {
      const el = folderHeader.closest('.folder');
      const collapsed = el.classList.toggle('folder--collapsed');
      folderHeader.querySelector('.folder-toggle-btn').textContent = collapsed ? '▸' : '▾';
      folderHeader.querySelector('.folder-toggle-btn').setAttribute('aria-expanded', String(!collapsed));
      folderHeader.querySelector('.folder-icon').textContent = collapsed ? '📁' : '📂';
      const ids = new Set(prefs.get('collapsedFolders', []));
      if (collapsed) ids.add(el.dataset.folderId); else ids.delete(el.dataset.folderId);
      prefs.set('collapsedFolders', [...ids]);
      return;
    }

    // Attachment image → lightbox
    const attachImg = e.target.closest('.hw-attach-img');
    if (attachImg) { openLightbox(attachImg.dataset.lightbox); return; }

    // Toggle topic collapse (click anywhere on header except + Add / drag handle)
    const header = e.target.closest('.class-header');
    if (header && !e.target.closest('.class-drag-handle')) {
      const row = header.closest('.class-row');
      const collapsed = row.classList.toggle('class-row--collapsed');
      const toggleBtn = header.querySelector('.class-toggle-btn');
      if (toggleBtn) {
        toggleBtn.textContent = collapsed ? '▸' : '▾';
        toggleBtn.setAttribute('aria-expanded', String(!collapsed));
      }
      // Persist collapsed state
      const classId = row.dataset.classId;
      const ids = Array.isArray(prefs.get('collapsedTopics', [])) ? prefs.get('collapsedTopics', []) : [];
      if (collapsed) { if (!ids.includes(classId)) ids.push(classId); }
      else           { const i = ids.indexOf(classId); if (i !== -1) ids.splice(i, 1); }
      prefs.set('collapsedTopics', ids);
      return;
    }

    // Toggle hw-item expand/collapse (click anywhere on item except interactive controls)
    const hwItem = e.target.closest('.hw-item--collapsible');
    if (hwItem && !e.target.closest('.hw-check-label') && !e.target.closest('.hw-edit-btn') && !e.target.closest('.hw-delete') && !e.target.closest('.hw-attach-file') && !e.target.closest('.hw-drag-handle')) {
      const expanded = hwItem.classList.toggle('hw-item--expanded');
      const hint = hwItem.querySelector('.hw-expand-hint');
      if (hint) hint.textContent = expanded ? '▴ less' : '▾ more';
      const ids = new Set(prefs.get('expandedHw', []));
      if (expanded) ids.add(hwItem.dataset.hwId);
      else ids.delete(hwItem.dataset.hwId);
      prefs.set('expandedHw', [...ids]);
    }
  });

  // Summary panel — edit, complete, and no-date section toggle
  document.getElementById('summary-list').addEventListener('click', e => {
    const toggle = e.target.closest('.summary-nodate-toggle');
    if (toggle) {
      const section = toggle.closest('.summary-nodate-section');
      const collapsed = section.classList.toggle('summary-nodate-section--collapsed');
      toggle.querySelector('.summary-nodate-chevron').textContent = collapsed ? '▾' : '▴';
      prefs.set('summaryNodateCollapsed', collapsed);
      return;
    }
    const editBtn = e.target.closest('.summary-btn--edit');
    const doneBtn = e.target.closest('.summary-btn--done');
    if (editBtn) openHwEditModal(editBtn.dataset.hwId);
    if (doneBtn) handleMarkComplete(doneBtn.dataset.hwId);
  });

  // Help section modals
  function openModal(id)  { document.getElementById(id).classList.add('modal--open'); }
  function closeModal(id) { document.getElementById(id).classList.remove('modal--open'); }

  document.getElementById('student-template-btn').addEventListener('click',  applyStudentTemplate);
  document.getElementById('college-template-btn').addEventListener('click',  applyCollegeTemplate);
  document.getElementById('work-template-btn').addEventListener('click',     applyWorkTemplate);
  document.getElementById('personal-template-btn').addEventListener('click', applyPersonalTemplate);

  document.getElementById('whats-new-btn').addEventListener('click',  () => openModal('whats-new-modal'));
  document.getElementById('privacy-btn').addEventListener('click',     () => openModal('privacy-modal'));
  document.getElementById('close-whats-new').addEventListener('click', () => closeModal('whats-new-modal'));
  document.getElementById('close-privacy').addEventListener('click',   () => closeModal('privacy-modal'));
  document.getElementById('whats-new-backdrop').addEventListener('click', () => closeModal('whats-new-modal'));
  document.getElementById('privacy-backdrop').addEventListener('click',   () => closeModal('privacy-modal'));

  // FAQ accordion
  document.querySelector('.faq-list').addEventListener('click', e => {
    const btn = e.target.closest('.faq-question');
    if (!btn) return;
    const item = btn.closest('.faq-item');
    const isOpen = item.classList.contains('open');
    document.querySelectorAll('.faq-item.open').forEach(el => el.classList.remove('open'));
    if (!isOpen) item.classList.add('open');
  });

  // Keyboard shortcuts
  document.addEventListener('keydown', e => {
    const mod = e.metaKey || e.ctrlKey;
    // Let the browser handle undo/redo while the user is editing text.
    const el  = e.target;
    const typing = el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
    if (mod && !typing && e.key==='z' && !e.shiftKey) { e.preventDefault(); history.undo(); return; }
    if (mod && !typing && (e.key==='y' || (e.key==='z' && e.shiftKey))) { e.preventDefault(); history.redo(); return; }
    if (e.key==='Escape') {
      if (!document.getElementById('lightbox').classList.contains('hidden')) { closeLightbox(); return; }
      if (sel.ids.size && !document.querySelector('.modal--open')) { clearSelection(); return; }
      closeHwModal(); closeSettings(); closeGroupForm();
      closeModal('whats-new-modal'); closeModal('privacy-modal');
      closePalette(); closeHelp();
    }
  });

  wirePalette();
  wireShortcuts();
}

export { wireEvents };
