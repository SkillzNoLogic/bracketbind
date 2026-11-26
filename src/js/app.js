import {
    Tournament, FORMATS, formatLabel, cleanPlayerName, isTBD, isBye, normalizePlayers,
    uniqueNames, roundRobinSchedule, swissRoundCount, maxSwissRounds,
} from './engine.js';
import {
    esc, splitSeed, prettyTBD, scheduleHtml, upNextHtml, standingsHtml, mountBracket, metaChips,
    rankBadge, formDots, bestOfLabel,
} from './views.js';
import {
    encodePackage, decodePackage, recordToPackage, packageToRecord, PasswordRequiredError, newId,
} from './backup.js';
import { createZip, readZip, isZip } from './zip.js';
import { icon, hydrateIcons } from './icons.js';
import * as platform from './platform.js';

// ============================================================================
// State
// ============================================================================

const BUILT_IN_ROSTER = [
    'Samarth', 'Karthik', 'Aditya.P', 'Aditya', 'Knaav', 'Zayan',
    'Sattva', 'Abir', 'Momin', 'Rayan', 'Pravar', 'Samar',
    'Saihej', 'Suhas', 'Vishank', 'Minraal',
];
const DEFAULT_PORT = 8787;

let state = { version: 2, activeId: null, settings: normalizeSettings({}), history: [], legacyChecked: false };
let currentView = 'home';
let activeTab = 'matches';
let T = null;
let undoStack = [];
let redoStack = [];
let standingsMode = 'standings';
let historyFilter = 'all';
let setup = null;
let editingMatch = null;
let live = { running: false, urls: [], qr_svg: null, port: 0, unsupported: !platform.isTauri, error: null };
const modalStack = [];

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const activeRecord = () => state.history.find((r) => r.id === state.activeId) || null;
const findRecord = (id) => state.history.find((r) => r.id === id) || null;
const engineFor = (rec) => new Tournament(rec);

function fmtDate(iso, withTime = true) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso);
    return withTime
        ? d.toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })
        : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function sanitizeFileName(name) {
    return String(name || 'tournament').replace(/[\\/:*?"<>|]+/g, '').replace(/\s+/g, '_').slice(0, 80) || 'tournament';
}

const FORMAT_ICON = { rr: ['teal', 'grid'], swiss: ['purple', 'shuffle'], se: ['blue', 'bracket'], de: ['orange', 'bracket'] };
const formatIcon = (f) => `<span class="app-icon ${FORMAT_ICON[f]?.[0] || 'blue'}">${icon(FORMAT_ICON[f]?.[1] || 'bracket')}</span>`;

function ringSvg(pct, done, size = 28) {
    const r = 11;
    const c = 2 * Math.PI * r;
    return `<svg class="ring ${done ? 'done' : ''}" viewBox="0 0 28 28" width="${size}" height="${size}"><circle class="track" cx="14" cy="14" r="${r}"/><circle class="value" cx="14" cy="14" r="${r}" stroke-dasharray="${c}" stroke-dashoffset="${c * (1 - pct)}"/></svg>`;
}

function normalizeRecord(r) {
    const idTime = /^t_(\d{12,})/.exec(r.id || '')?.[1];
    const created = r.createdAt || (idTime ? new Date(Number(idTime)).toISOString() : new Date().toISOString());
    return {
        id: r.id || newId(),
        name: String(r.name || 'Untitled Tournament'),
        date: r.date || new Date(created).toLocaleDateString(),
        createdAt: created,
        updatedAt: r.updatedAt || created,
        lastUpdated: r.lastUpdated,
        format: FORMATS[r.format] ? r.format : 'rr',
        winThreshold: Number(r.winThreshold) || 3,
        players: normalizePlayers(r.players),
        matchScores: r.matchScores && typeof r.matchScores === 'object' ? r.matchScores : {},
        completedAt: r.completedAt || null,
        swissRounds: Number(r.swissRounds) || undefined,
        thirdPlace: !!r.thirdPlace,
    };
}

function normalizeSettings(s = {}) {
    const roster = Array.isArray(s.defaultRoster) ? uniqueNames(s.defaultRoster) : [];
    const port = Number(s.livePort);
    return {
        defaultRosterEnabled: s.defaultRosterEnabled !== undefined ? !!s.defaultRosterEnabled : true,
        defaultRoster: roster.length ? roster : [...BUILT_IN_ROSTER],
        defaultFormat: FORMATS[s.defaultFormat] ? s.defaultFormat : 'rr',
        defaultFirstTo: Number(s.defaultFirstTo) || 3,
        theme: ['system', 'light', 'dark'].includes(s.theme) ? s.theme : 'system',
        liveShare: s.liveShare !== undefined ? !!s.liveShare : true,
        livePort: port >= 1024 && port <= 65000 ? port : DEFAULT_PORT,
    };
}

// ============================================================================
// Persistence
// ============================================================================

let saving = false;
let saveQueued = false;

function setSaveStatus(kind, detail) {
    const el = $('#save-status');
    el.dataset.state = kind;
    $('.label', el).textContent = kind === 'saving' ? 'Saving…' : kind === 'error' ? 'Save failed' : 'Saved';
    el.title = detail || '';
}

async function persist() {
    if (saving) { saveQueued = true; return; }
    saving = true;
    setSaveStatus('saving');
    try {
        await platform.saveState(JSON.stringify(state));
        setSaveStatus('saved');
    } catch (e) {
        console.error('Save failed', e);
        setSaveStatus('error', String(e?.message || e));
        toast(`Couldn’t save: ${e?.message || e}`, 'err');
    } finally {
        saving = false;
        if (saveQueued) { saveQueued = false; persist(); }
    }
}

function touch(rec) {
    rec.updatedAt = new Date().toISOString();
    rec.lastUpdated = new Date().toLocaleString();
}

// ============================================================================
// UI primitives
// ============================================================================

function toast(message, kind = 'ok', { action, onAction, timeout = 3000 } = {}) {
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.innerHTML = `${icon(kind === 'err' ? 'alert' : kind === 'info' ? 'info' : 'check-circle', 'ic')}<span>${esc(message)}</span>`;
    const dismiss = () => { el.classList.add('out'); setTimeout(() => el.remove(), 260); };
    if (action) {
        const b = document.createElement('button');
        b.className = 'btn small';
        b.textContent = action;
        b.onclick = () => { onAction?.(); dismiss(); };
        el.appendChild(b);
    }
    const box = $('#toasts');
    box.appendChild(el);
    while (box.children.length > 3) box.firstElementChild.remove();
    setTimeout(dismiss, kind === 'err' ? Math.max(timeout, 6000) : timeout);
}

function openModal(id) {
    const el = document.getElementById(id);
    if (!el.classList.contains('on')) { el.classList.add('on'); modalStack.push(id); }
}

function closeModal(id = modalStack[modalStack.length - 1]) {
    if (!id) return;
    document.getElementById(id)?.classList.remove('on');
    const i = modalStack.lastIndexOf(id);
    if (i >= 0) modalStack.splice(i, 1);
    if (id === 'modal-match') editingMatch = null;
}

let dialogResolve = null;

/** In-app alert / confirm / prompt. */
function dialog({ title, body = '', ok = 'OK', cancel = 'Cancel', danger = false, input = null, alert = false, iconName = null, tone = null }) {
    if (dialogResolve) dialogResolve(input ? null : false);
    $('#dlg-title').textContent = title;
    $('#dlg-body').textContent = body;
    $('#dlg-body').style.display = body ? '' : 'none';
    const ic = $('#dlg-icon');
    const t = tone || (danger ? 'red' : input ? 'blue' : alert ? 'orange' : 'blue');
    ic.className = `app-icon ${t}`;
    ic.innerHTML = icon(iconName || (danger ? 'trash' : input ? 'pencil' : alert ? 'alert' : 'info'));
    const inp = $('#dlg-input');
    inp.style.display = input ? '' : 'none';
    if (input) {
        inp.type = input.type || 'text';
        inp.value = input.value || '';
        inp.placeholder = input.placeholder || '';
    }
    const okBtn = $('#dlg-ok');
    okBtn.textContent = ok;
    okBtn.className = `btn prominent${danger ? ' destructive' : ''}`;
    $('#dlg-cancel').textContent = cancel;
    $('#dlg-cancel').style.display = alert ? 'none' : '';
    openModal('modal-dialog');
    setTimeout(() => (input ? inp.select() : okBtn.focus()), 40);
    return new Promise((resolve) => {
        dialogResolve = (v) => { dialogResolve = null; closeModal('modal-dialog'); resolve(v); };
    });
}

const confirmDialog = (title, body, ok = 'OK', danger = false) => dialog({ title, body, ok, danger });
const alertDialog = (title, body) => dialog({ title, body, alert: true });

function initDialog() {
    $('#dlg-ok').addEventListener('click', () => dialogResolve?.($('#dlg-input').style.display === 'none' ? true : $('#dlg-input').value));
    $('#dlg-cancel').addEventListener('click', () => dialogResolve?.($('#dlg-input').style.display === 'none' ? false : null));
    $('#dlg-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#dlg-ok').click(); } });
}

function closePopMenus() { $$('.pop-menu.on').forEach((m) => m.classList.remove('on')); }

/** Segmented controls with a sliding glass thumb. */
function setSegmented(el, attr, value) {
    if (!el) return;
    // `attr` is the dataset key (camelCase); the selector needs the kebab-case attribute.
    const kebab = attr.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
    const buttons = $$(`button[data-${kebab}]`, el);
    buttons.forEach((b) => b.classList.toggle('on', b.dataset[attr] === value));
    const on = buttons.find((b) => b.dataset[attr] === value);
    const thumb = $('.seg-thumb', el);
    if (!on || !thumb) return;
    const place = () => {
        if (!on.offsetWidth) return;
        thumb.style.left = `${on.offsetLeft}px`;
        thumb.style.width = `${on.offsetWidth}px`;
    };
    place();
    requestAnimationFrame(place);
}
const refreshAllSegmented = () => {
    setSegmented($('#tabs'), 'tab', activeTab);
    setSegmented($('#standings-mode'), 'mode', standingsMode);
    setSegmented($('#history-filter'), 'filter', historyFilter);
    setSegmented($('#setting-theme'), 'themeChoice', state.settings.theme);
};

// ============================================================================
// Theme
// ============================================================================

const darkMQ = window.matchMedia('(prefers-color-scheme: dark)');

function applyTheme() {
    const pref = state.settings.theme || 'system';
    document.documentElement.dataset.theme = pref === 'system' ? (darkMQ.matches ? 'dark' : 'light') : pref;
    setSegmented($('#setting-theme'), 'themeChoice', pref);
}

function setTheme(pref) {
    state.settings.theme = pref;
    applyTheme();
    persist();
}

const toggleTheme = () => setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');

// ============================================================================
// Navigation & chrome
// ============================================================================

const VIEW_NAMES = { home: 'Home', setup: 'New Tournament', active: 'Tournament', history: 'History', data: 'Import & Export', settings: 'Settings' };

function go(view) {
    if (view === 'active' && !activeRecord()) {
        toast('No tournament is open. Start one or open one from History.', 'info');
        view = 'home';
    }
    closePopMenus();
    while (modalStack.length) closeModal();
    currentView = view;
    $$('.view').forEach((v) => v.classList.toggle('on', v.id === `view-${view}`));
    $('#page-scroll').scrollTop = 0;
    $('.main').classList.remove('scrolled');

    if (view === 'home') renderHome();
    if (view === 'active') renderActive();
    if (view === 'history') renderHistory();
    if (view === 'data') renderData();
    if (view === 'settings') renderSettings();
    if (view === 'setup') renderSetup();
    renderChrome();
    requestAnimationFrame(refreshAllSegmented);
}

function renderChrome() {
    const rec = activeRecord();
    $$('.nav-item').forEach((b) => b.classList.toggle('on', b.dataset.view === currentView || b.dataset.nav === currentView));
    $('#nav-history-count').textContent = state.history.length || '';
    $('#toolbar-title').textContent = currentView === 'active' && rec ? rec.name : VIEW_NAMES[currentView];
    platform.setWindowTitle(currentView === 'active' && rec ? `${rec.name} — Bracket Maker` : 'Bracket Maker');

    if (rec) {
        const t = currentView === 'active' && T ? T : engineFor(rec);
        const p = t.progress();
        const done = t.isComplete();
        $('#nav-current').innerHTML = `<button class="nav-current ${currentView === 'active' ? 'on' : ''}" data-action="go" data-view="active">
            ${ringSvg(p.total ? p.done / p.total : 0, done)}
            <div class="grow"><b>${esc(rec.name)}</b><small>${done ? 'Complete' : `${p.done} of ${p.total} played`}</small></div>
        </button>`;
    } else {
        $('#nav-current').innerHTML = '<div class="nav-empty">No tournament open</div>';
    }
    renderToolbar();
    renderLiveCard();
}

function renderToolbar() {
    const box = $('#toolbar-dynamic');
    if (currentView !== 'active' || !activeRecord()) { box.innerHTML = ''; return; }
    const liveBtn = live.unsupported ? '' : `<button class="btn" data-action="open-live" title="Live website">
        <span class="live-dot ${live.running ? 'on' : ''}"></span>${live.running ? 'Live' : 'Share'}</button>`;
    box.innerHTML = `
        <div class="capsule glass">
            <button class="icon-btn" data-action="undo" id="undo-btn">${icon('undo')}</button>
            <button class="icon-btn" data-action="redo" id="redo-btn">${icon('redo')}</button>
        </div>
        ${liveBtn}
        <div class="menu-wrap">
            <button class="icon-btn filled" data-action="toggle-menu" data-menu="active-more" title="More">${icon('more')}</button>
            <div class="pop-menu" id="active-more">
                <button data-action="print">${icon('print')}Print Bracket…</button>
                <button data-action="export-results">${icon('download')}Export Results (.txt)…</button>
                <button data-action="export-results-csv">${icon('download')}Export Results (.csv)…</button>
                <button data-action="export-active-backup">${icon('upload')}Export Backup…</button>
                <hr>
                <button data-action="reset-scores" class="destructive">${icon('restart')}Reset All Scores</button>
            </div>
        </div>`;
    updateUndoButtons();
}

function updateUndoButtons() {
    const u = $('#undo-btn');
    const r = $('#redo-btn');
    if (!u) return;
    u.disabled = !undoStack.length;
    r.disabled = !redoStack.length;
    u.title = undoStack.length ? `Undo ${undoStack[undoStack.length - 1].label} (${platform.modKey}Z)` : 'Nothing to undo';
    r.title = redoStack.length ? `Redo ${redoStack[redoStack.length - 1].label}` : 'Nothing to redo';
}

// ============================================================================
// Home
// ============================================================================

function renderHome() {
    $('#home-sub').textContent = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
    const rec = activeRecord();
    const hero = $('#home-hero');
    if (rec) {
        const t = engineFor(rec);
        const p = t.progress();
        const done = t.isComplete();
        const pct = p.total ? p.done / p.total : 0;
        const c = 2 * Math.PI * 42;
        const next = t.upNext(3);
        const leader = t.finalRankings()[0];
        let preview = '';
        if (done && leader) preview = `<div class="next-preview"><div>${icon('trophy')} Winner: <b>${esc(leader.name)}</b></div></div>`;
        else if (next.length) {
            preview = `<div class="next-preview">${next.map((m) => `<div><b>${esc(cleanPlayerName(m.p1))}</b> vs <b>${esc(cleanPlayerName(m.p2))}</b> · ${esc(m.round)}</div>`).join('')}</div>`;
        }
        hero.innerHTML = `
            <div class="hero glass-strong" data-action="go" data-view="active">
                <div>
                    <div class="eyebrow ${done ? 'done' : ''}">${icon(done ? 'check-circle' : 'play')}${done ? 'Completed' : 'In progress'}</div>
                    <h2>${esc(rec.name)}</h2>
                    <div class="chips">${metaChips(t, rec)}</div>
                    ${preview}
                </div>
                <div class="hero-side">
                    <div class="big-ring">
                        <svg viewBox="0 0 100 100"><circle class="track" cx="50" cy="50" r="42"/><circle class="value" cx="50" cy="50" r="42" stroke="url(#ringGrad)" stroke-dasharray="${c}" stroke-dashoffset="${c * (1 - pct)}"/></svg>
                        <div class="label"><div>${Math.round(pct * 100)}%<small>${p.done}/${p.total}</small></div></div>
                    </div>
                    <button class="btn prominent">${done ? 'View Results' : 'Continue'}</button>
                </div>
            </div>`;
    } else {
        hero.innerHTML = `
            <div class="welcome glass-strong">
                <div class="brand-mark">${icon('trophy')}</div>
                <h2>No tournament in progress</h2>
                <p>Start a Round Robin, Swiss, Single or Double Elimination event, or open one from your history.</p>
                <button class="btn prominent large" data-action="new-tournament">${icon('plus')} New Tournament</button>
            </div>`;
    }

    const n = state.history.length;
    $('#tile-history-sub').textContent = n ? `${n} saved tournament${n === 1 ? '' : 's'}` : 'No tournaments yet';
    $('#tile-live-sub').textContent = live.unsupported ? 'Available in the desktop app' : live.running ? live.urls[0]?.replace('http://', '') || 'Running' : 'Share on your network';

    const recent = [...state.history].sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || '')).filter((r) => r.id !== state.activeId).slice(0, 5);
    $('#home-recent').innerHTML = recent.length ? `
        <div class="section-title">Recent <button class="btn small plain" data-action="go" data-view="history">Show All</button></div>
        <div class="list">${recent.map((r) => `
            <div class="list-row tappable indent" data-action="open-record" data-id="${esc(r.id)}">
                ${formatIcon(r.format)}
                <div class="grow"><div class="title">${esc(r.name)}</div><div class="sub">${formatLabel(r.format, true)} · ${r.players.length} players · ${esc(fmtDate(r.updatedAt))}</div></div>
                ${icon('chevron-right', 'chev')}
            </div>`).join('')}</div>` : '';
}

// ============================================================================
// Setup wizard
// ============================================================================

const STEPS = ['details', 'players', 'checkin', 'seeding'];

function startSetup(prefill = null) {
    const s = state.settings;
    setup = {
        step: prefill?.step || 'details',
        name: prefill?.name || '',
        format: prefill?.format || s.defaultFormat,
        firstTo: prefill?.firstTo || s.defaultFirstTo,
        thirdPlace: !!prefill?.thirdPlace,
        swissRounds: prefill?.swissRounds || null,
        roster: prefill?.roster ? [...prefill.roster] : (s.defaultRosterEnabled ? [...s.defaultRoster] : []),
        checked: {},
        seeds: [],
    };
    $('#setup-name').value = setup.name;
    go('setup');
    if (setup.step === 'details') setTimeout(() => $('#setup-name').focus(), 60);
}

function renderSetup() {
    if (!setup) { startSetup(); return; }
    const idx = STEPS.indexOf(setup.step);
    $$('#stepper li').forEach((li, i) => {
        li.classList.toggle('on', i === idx);
        li.classList.toggle('done', i < idx);
        li.querySelector('span').innerHTML = i < idx ? icon('check') : String(i + 1);
    });
    $$('#view-setup .step').forEach((s) => s.classList.toggle('on', s.dataset.step === setup.step));
    if (setup.step === 'details') renderDetailsStep();
    if (setup.step === 'players') renderPlayerEntry();
    if (setup.step === 'checkin') renderCheckIn();
    if (setup.step === 'seeding') renderSeeding();
}

function renderDetailsStep() {
    $$('#setup-format .format-card').forEach((c) => c.classList.toggle('on', c.dataset.format === setup.format));
    $$('#setup-length button').forEach((b) => b.classList.toggle('on', Number(b.dataset.firstTo) === setup.firstTo));
    $('#opt-third').classList.toggle('hidden', setup.format !== 'se');
    $('#setup-third').checked = setup.thirdPlace;
}

function setupNext() {
    if (setup.step === 'details') {
        setup.name = $('#setup-name').value.trim();
        setup.thirdPlace = $('#setup-third').checked;
        setup.step = 'players';
    } else if (setup.step === 'players') {
        syncRosterFromInputs();
        const raw = setup.roster.map((n) => n.trim()).filter(Boolean);
        const names = uniqueNames(raw);
        if (names.length < 2) { alertDialog('Add more players', 'A tournament needs at least two players.'); return; }
        if (names.length < raw.length) toast(`Removed ${raw.length - names.length} duplicate name${raw.length - names.length === 1 ? '' : 's'}`, 'info');
        setup.roster = names;
        names.forEach((n) => { if (setup.checked[n] === undefined) setup.checked[n] = true; });
        setup.step = 'checkin';
    } else if (setup.step === 'checkin') {
        const ins = setup.roster.filter((n) => setup.checked[n]);
        if (ins.length < 2) { alertDialog('Check in more players', 'At least two players must be checked in.'); return; }
        const kept = setup.seeds.filter((n) => ins.includes(n));
        setup.seeds = [...kept, ...ins.filter((n) => !kept.includes(n))];
        setup.step = 'seeding';
    }
    renderSetup();
}

function setupBack() {
    if (setup.step === 'players') syncRosterFromInputs();
    const i = STEPS.indexOf(setup.step);
    if (i > 0) { setup.step = STEPS[i - 1]; renderSetup(); } else go('home');
}

function entryRow(name, i) {
    return `<div class="entry">
        <span class="n">${i + 1}</span>
        <input type="text" class="input pe-input" value="${esc(name)}" placeholder="Player name" autocomplete="off" spellcheck="false">
        <button class="x-btn" data-action="remove-entry" tabindex="-1" title="Remove">${icon('x')}</button>
    </div>`;
}

function renderPlayerEntry() {
    const list = $('#setup-player-list');
    const names = [...setup.roster];
    if (names.length === 0 || names[names.length - 1].trim() !== '') names.push('');
    setup.roster = names;
    list.innerHTML = names.map(entryRow).join('');
    refreshEntryMeta();
    const sel = $('#saved-roster-select');
    const usable = [...state.history].sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || '')).filter((r) => r.players.length);
    sel.innerHTML = usable.length
        ? `<option value="">Roster from a past tournament…</option>${usable.map((r) => `<option value="${esc(r.id)}">${esc(r.name)} (${r.players.length})</option>`).join('')}`
        : '<option value="">No saved rosters</option>';
}

function refreshEntryMeta() {
    const inputs = $$('#setup-player-list .pe-input');
    const counts = {};
    inputs.forEach((inp) => { const k = inp.value.trim().toLowerCase(); if (k) counts[k] = (counts[k] || 0) + 1; });
    inputs.forEach((inp) => inp.classList.toggle('dup', counts[inp.value.trim().toLowerCase()] > 1));
    $('#player-count').textContent = String(Object.keys(counts).length);
    $$('#setup-player-list .entry .n').forEach((n, i) => { n.textContent = i + 1; });
}

function syncRosterFromInputs() {
    const inputs = $$('#setup-player-list .pe-input');
    if (inputs.length) setup.roster = inputs.map((i) => i.value);
}

function ensureTrailingEntry() {
    const list = $('#setup-player-list');
    const inputs = $$('.pe-input', list);
    const last = inputs[inputs.length - 1];
    if (!last || last.value.trim() !== '') list.insertAdjacentHTML('beforeend', entryRow('', inputs.length));
}

function initPlayerEntry() {
    const list = $('#setup-player-list');
    list.addEventListener('input', (e) => {
        if (!e.target.classList.contains('pe-input')) return;
        ensureTrailingEntry();
        syncRosterFromInputs();
        refreshEntryMeta();
    });
    list.addEventListener('keydown', (e) => {
        if (!e.target.classList.contains('pe-input')) return;
        const inputs = $$('.pe-input', list);
        const i = inputs.indexOf(e.target);
        if (e.key === 'Enter') {
            e.preventDefault();
            if (e.metaKey || e.ctrlKey) { setupNext(); return; }
            ensureTrailingEntry();
            $$('.pe-input', list)[i + 1]?.focus();
        } else if (e.key === 'Backspace' && e.target.value === '' && inputs.length > 1 && i > 0) {
            e.preventDefault();
            e.target.closest('.entry').remove();
            inputs[i - 1].focus();
            syncRosterFromInputs();
            refreshEntryMeta();
        } else if (e.key === 'ArrowDown') inputs[i + 1]?.focus();
        else if (e.key === 'ArrowUp') inputs[i - 1]?.focus();
    });
    list.addEventListener('paste', (e) => {
        if (!e.target.classList.contains('pe-input')) return;
        const lines = (e.clipboardData?.getData('text') || '').split(/\r?\n|,|\t/).map((s) => s.trim()).filter(Boolean);
        if (lines.length < 2) return;
        e.preventDefault();
        syncRosterFromInputs();
        const i = $$('.pe-input', list).indexOf(e.target);
        const roster = setup.roster.slice();
        roster.splice(i, roster[i]?.trim() ? 0 : 1, ...lines);
        setup.roster = roster.filter((n, idx) => n.trim() || idx === roster.length - 1);
        renderPlayerEntry();
        toast(`Added ${lines.length} players`);
    });
}

function renderCheckIn() {
    $('#checkin-list').innerHTML = setup.roster.map((n) => `
        <label class="checkin ${setup.checked[n] ? '' : 'off'}">
            <input type="checkbox" data-name="${esc(n)}" ${setup.checked[n] ? 'checked' : ''}>
            <span>${esc(n)}</span>
        </label>`).join('');
    updateCheckinCount();
}

function updateCheckinCount() {
    $('#checkin-count').textContent = `${setup.roster.filter((x) => setup.checked[x]).length} / ${setup.roster.length}`;
}

function renderSeeding() {
    const n = setup.seeds.length;
    $('#opt-rounds').classList.toggle('hidden', setup.format !== 'swiss');
    if (setup.format === 'swiss') {
        const rec = swissRoundCount(n);
        const max = maxSwissRounds(n);
        const cur = Math.min(setup.swissRounds || rec, max);
        $('#setup-rounds').innerHTML = Array.from({ length: max }, (_, i) => i + 1)
            .map((r) => `<option value="${r}" ${r === cur ? 'selected' : ''}>${r} round${r === 1 ? '' : 's'}${r === rec ? ' (recommended)' : ''}</option>`).join('');
        $('#rounds-hint').textContent = `${rec} rounds separates a clear winner among ${n} players.`;
    }
    $('#seeding-list').innerHTML = setup.seeds.map((name, i) => `
        <div class="seed-row" data-i="${i}">
            ${icon('grip', 'grip')}
            ${rankBadge({ place: i + 1, placeLabel: String(i + 1) })}
            <span class="name">${esc(name)}</span>
            <span class="arrows">
                <button class="icon-btn" data-action="seed-move" data-i="${i}" data-d="-1" title="Move up" ${i === 0 ? 'disabled' : ''}>${icon('chevron-up')}</button>
                <button class="icon-btn" data-action="seed-move" data-i="${i}" data-d="1" title="Move down" ${i === n - 1 ? 'disabled' : ''}>${icon('chevron-down')}</button>
            </span>
        </div>`).join('');
}

function moveSeed(from, to) {
    if (from === to || to < 0 || to >= setup.seeds.length) return;
    const [m] = setup.seeds.splice(from, 1);
    setup.seeds.splice(to, 0, m);
    renderSeeding();
}

/** Pointer-driven reordering (HTML5 drag & drop is unreliable inside native webviews). */
function initSeedDrag() {
    const list = $('#seeding-list');
    list.addEventListener('pointerdown', (e) => {
        const row = e.target.closest('.seed-row');
        if (!row || e.target.closest('button') || e.button !== 0) return;
        e.preventDefault();
        const rows = $$('.seed-row', list);
        const from = rows.indexOf(row);
        const step = row.getBoundingClientRect().height + 6;
        const startY = e.clientY;
        const startScroll = list.scrollTop;
        let to = from;
        let lastY = e.clientY;
        row.setPointerCapture(e.pointerId);
        row.classList.add('dragging');
        rows.forEach((r) => { if (r !== row) r.classList.add('shift'); });
        const update = () => {
            const dy = lastY - startY + (list.scrollTop - startScroll);
            row.style.transform = `translateY(${dy}px) scale(1.02)`;
            to = Math.max(0, Math.min(rows.length - 1, from + Math.round(dy / step)));
            rows.forEach((r, i) => {
                if (r === row) return;
                let shift = 0;
                if (from < i && i <= to) shift = -step;
                else if (to <= i && i < from) shift = step;
                r.style.transform = shift ? `translateY(${shift}px)` : '';
            });
        };
        const onMove = (ev) => {
            lastY = ev.clientY;
            const rect = list.getBoundingClientRect();
            if (ev.clientY < rect.top + 30) list.scrollTop -= 10;
            else if (ev.clientY > rect.bottom - 30) list.scrollTop += 10;
            update();
        };
        const onUp = () => {
            row.removeEventListener('pointermove', onMove);
            row.removeEventListener('pointerup', onUp);
            row.removeEventListener('pointercancel', onUp);
            if (from === to) renderSeeding(); else moveSeed(from, to);
        };
        row.addEventListener('pointermove', onMove);
        row.addEventListener('pointerup', onUp);
        row.addEventListener('pointercancel', onUp);
    });
}

function launchTournament() {
    if (!setup || setup.seeds.length < 2) return;
    const now = new Date();
    const rec = normalizeRecord({
        id: newId(),
        name: setup.name || `Tournament #${state.history.length + 1}`,
        date: now.toLocaleDateString(),
        createdAt: now.toISOString(),
        format: setup.format,
        winThreshold: setup.firstTo,
        players: setup.seeds.map((name, i) => ({ name, seed: i + 1, isDQ: false })),
        matchScores: {},
        thirdPlace: setup.format === 'se' && setup.thirdPlace,
        swissRounds: setup.format === 'swiss' ? Number($('#setup-rounds').value) || undefined : undefined,
    });
    touch(rec);
    state.history.push(rec);
    setup = null;
    activeTab = 'matches';
    openRecord(rec.id);
    toast(`${rec.name} started`);
}

// ============================================================================
// Active tournament
// ============================================================================

function openRecord(id, tab) {
    const rec = findRecord(id);
    if (!rec) return;
    if (state.activeId !== id) { undoStack = []; redoStack = []; activeTab = 'matches'; }
    if (tab) activeTab = tab;
    state.activeId = id;
    T = engineFor(rec);
    if (T.isComplete() && !rec.completedAt) rec.completedAt = rec.updatedAt;
    $('#search-input').value = '';
    $('#round-filter').value = 'all';
    persist();
    go('active');
    syncLive();
}

function snapshot(rec) {
    return JSON.stringify({ name: rec.name, players: rec.players, matchScores: rec.matchScores, completedAt: rec.completedAt });
}

function restore(rec, snap) {
    const s = JSON.parse(snap);
    rec.name = s.name;
    rec.players = s.players;
    rec.matchScores = s.matchScores;
    rec.completedAt = s.completedAt;
}

/** Apply an undoable change to the active tournament, then re-render and save. */
function mutate(label, fn) {
    const rec = activeRecord();
    if (!rec) return;
    undoStack.push({ label, snap: snapshot(rec) });
    if (undoStack.length > 200) undoStack.shift();
    redoStack = [];
    fn(rec);
    afterChange(rec, true);
}

function afterChange(rec, checkCompletion) {
    touch(rec);
    T = engineFor(rec);
    const complete = T.isComplete();
    let justCompleted = false;
    if (complete && !rec.completedAt) { rec.completedAt = new Date().toISOString(); justCompleted = checkCompletion; }
    else if (!complete && rec.completedAt) rec.completedAt = null;
    renderActive();
    renderChrome();
    if (editingMatch) renderMatchEditor();
    persist();
    pushLive();
    if (justCompleted) setTimeout(showFinalResults, 350);
}

const isTextField = (el) => el && (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && !['checkbox', 'radio', 'button'].includes(el.type)));

function undo() {
    if (isTextField(document.activeElement)) { document.execCommand('undo'); return; }
    const rec = activeRecord();
    if (currentView !== 'active' || !rec || !undoStack.length) return;
    const entry = undoStack.pop();
    redoStack.push({ label: entry.label, snap: snapshot(rec) });
    restore(rec, entry.snap);
    afterChange(rec, false);
    toast(`Undid ${entry.label}`, 'info', { timeout: 1800 });
}

function redo() {
    if (isTextField(document.activeElement)) { document.execCommand('redo'); return; }
    const rec = activeRecord();
    if (currentView !== 'active' || !rec || !redoStack.length) return;
    const entry = redoStack.pop();
    undoStack.push({ label: entry.label, snap: snapshot(rec) });
    restore(rec, entry.snap);
    afterChange(rec, false);
    toast(`Redid ${entry.label}`, 'info', { timeout: 1800 });
}

const BRACKET_TAB_LABEL = { rr: 'Grid', swiss: 'Rounds', se: 'Bracket', de: 'Bracket' };

function renderActive() {
    const rec = activeRecord();
    if (!rec) return;
    if (!T) T = engineFor(rec);
    $('#active-title').textContent = rec.name;
    $('#active-chips').innerHTML = metaChips(T, rec);
    const p = T.progress();
    $('#active-progress').style.width = `${p.total ? (p.done / p.total) * 100 : 0}%`;
    $('#tab-bracket span').textContent = BRACKET_TAB_LABEL[rec.format];
    $('#final-btn-wrap').innerHTML = T.isComplete() ? `<button class="btn" data-action="show-final">${icon('trophy')} Final Results</button>` : '';
    $$('#view-active .tab-panel').forEach((pnl) => pnl.classList.toggle('on', pnl.dataset.tab === activeTab));
    setSegmented($('#tabs'), 'tab', activeTab);
    updateUndoButtons();
    renderTab();
}

function renderTab() {
    if (activeTab === 'matches') renderMatchesTab();
    else if (activeTab === 'bracket') renderBracketTab();
    else if (activeTab === 'standings') renderStandingsTab();
    else if (activeTab === 'players') renderPlayersTab();
}

function switchTab(tab) {
    activeTab = tab;
    $$('#view-active .tab-panel').forEach((pnl) => pnl.classList.toggle('on', pnl.dataset.tab === tab));
    setSegmented($('#tabs'), 'tab', tab);
    renderTab();
}

function renderMatchesTab() {
    const sel = $('#round-filter');
    const prev = sel.value || 'all';
    const sections = T.sections();
    sel.innerHTML = `<option value="all">All rounds</option>${sections.map((s, i) => `<option value="${i}">${esc(s.title)}</option>`).join('')}`;
    sel.value = [...sel.options].some((o) => o.value === prev) ? prev : 'all';

    const next = upNextHtml(T, { editable: true, limit: 4 });
    $('#upnext-wrap').classList.toggle('hidden', !next || T.isComplete());
    $('#upnext').innerHTML = next;
    renderSchedule();
    $('#side-standings').innerHTML = standingsHtml(T, { compact: true, limit: 8 });
}

function renderSchedule() {
    if (!T) return;
    $('#schedule').innerHTML = T.players.length
        ? scheduleHtml(T, {
            editable: true,
            query: $('#search-input').value,
            round: $('#round-filter').value || 'all',
            hideDone: $('#hide-done').checked,
            repair: T.repairableSwissRound(),
        })
        : `<div class="empty">${icon('users')}<p>No players registered.</p></div>`;
}

function renderBracketTab() {
    mountBracket($('#bracket'), T, { editable: true, onEdit: openMatchEditor, zoomKey: state.activeId });
    $('#bracket-hint').textContent = {
        rr: 'Each row shows that player’s result against each column. Hover a name to highlight it.',
        swiss: 'Rounds are grouped by record going into the round. Click a match to enter a result.',
        se: 'Click a match to enter a result. Hover a player to trace their path. Ctrl/⌘ + scroll to zoom.',
        de: 'Click a match to enter a result. Hover a player to trace their path. Ctrl/⌘ + scroll to zoom.',
    }[T.format];
}

function renderStandingsTab() {
    setSegmented($('#standings-mode'), 'mode', standingsMode);
    $('#standings-full').innerHTML = standingsHtml(T, { mode: standingsMode });
    $('#tiebreak-hint').textContent = standingsMode === 'points' ? 'Sorted by total games won.'
        : T.format === 'swiss' ? 'Tiebreaks: wins, Buchholz, game difference, head-to-head, points.'
            : T.format === 'rr' ? 'Tiebreaks: wins, game difference, head-to-head, points.'
                : 'Placed by how far each player went in the bracket.';
}

function renderPlayersTab() {
    const rec = activeRecord();
    const players = [...rec.players].sort((a, b) => a.seed - b.seed);
    const tally = T.tally();
    const dq = players.filter((p) => p.isDQ).length;
    $('#players-summary').textContent = `${players.length - dq} active${dq ? ` · ${dq} disqualified` : ''}`;
    $('#players-list').innerHTML = players.map((p) => `
        <div class="list-row player-row ${p.isDQ ? 'is-dq' : ''}">
            ${rankBadge({ place: p.seed, placeLabel: String(p.seed) })}
            <div class="grow"><div class="title"><button class="link" data-action="player" data-name="${esc(p.name)}">${esc(p.name)}</button></div>
                <div class="sub">${tally[p.name] ? `${tally[p.name].wins}–${tally[p.name].losses} · ${tally[p.name].points} pts` : ''}${p.isDQ ? ' · Disqualified' : ''}</div></div>
            <div class="acts">
                <button class="icon-btn" data-action="rename-player" data-name="${esc(p.name)}" title="Rename">${icon('pencil')}</button>
                <button class="btn small ${p.isDQ ? '' : 'destructive'}" data-action="toggle-dq" data-name="${esc(p.name)}">${p.isDQ ? 'Reinstate' : 'Disqualify'}</button>
                <button class="icon-btn danger" data-action="remove-player" data-name="${esc(p.name)}" title="Remove">${icon('trash')}</button>
            </div>
        </div>`).join('');
}

// ---------- Score editing ----------
function setScore(matchId, values) {
    const rec = activeRecord();
    const m = rec?.matchScores[matchId];
    if (!m) return;
    const label = `${cleanPlayerName(m.player1)} vs ${cleanPlayerName(m.player2)}`;
    mutate(`score ${label}`, (r) => {
        const s = r.matchScores[matchId];
        Object.assign(s, values);
        const tgt = r.winThreshold;
        if (s.p1 === tgt && s.p2 === tgt) {
            if ('p1' in values && !('p2' in values)) s.p2 = tgt - 1;
            else s.p1 = tgt - 1;
        }
    });
}

function openMatchEditor(id) {
    editingMatch = id;
    renderMatchEditor();
    openModal('modal-match');
}

function renderMatchEditor() {
    const m = T.findMatch(editingMatch);
    if (!m) { closeModal('modal-match'); return; }
    const s = T.score(m.id, m.p1, m.p2);
    const tgt = T.target;
    $('#me-title').textContent = `${cleanPlayerName(m.p1)} vs ${cleanPlayerName(m.p2)}`;
    $('#me-sub').textContent = `${m.round} · ${bestOfLabel(T)} · first to ${tgt}`;
    const side = (label, key, val, other) => {
        const { name } = splitSeed(label);
        const seed = T.seedOf[name];
        const win = val === tgt;
        return `<div class="me-side ${win ? 'win' : ''}">
            <div><b>${esc(name)}</b><small>Seed ${seed}${win ? ' · Winner' : ''}</small></div>
            <div class="stepper-ctl">
                <button data-action="me-step" data-key="${key}" data-d="-1" ${val <= 0 ? 'disabled' : ''}>${icon('minus')}</button>
                <b>${val}</b>
                <button data-action="me-step" data-key="${key}" data-d="1" ${val >= tgt || (other === tgt && val >= tgt - 1) ? 'disabled' : ''}>${icon('plus')}</button>
            </div>
        </div>`;
    };
    $('#me-body').innerHTML = `
        ${side(m.p1, 'p1', s.p1, s.p2)}
        ${side(m.p2, 'p2', s.p2, s.p1)}
        <div class="me-quick">
            <button class="btn" data-action="me-win" data-key="p1">${esc(cleanPlayerName(m.p1))} wins</button>
            <button class="btn" data-action="me-win" data-key="p2">${esc(cleanPlayerName(m.p2))} wins</button>
        </div>`;
}

function meStep(key, d) {
    const m = T.findMatch(editingMatch);
    if (!m) return;
    const s = T.score(m.id, m.p1, m.p2);
    const v = Math.max(0, Math.min(T.target, s[key] + d));
    setScore(m.id, { [key]: v });
}

function meWin(key) {
    const m = T.findMatch(editingMatch);
    if (!m) return;
    const s = T.score(m.id, m.p1, m.p2);
    const other = key === 'p1' ? 'p2' : 'p1';
    setScore(m.id, { [key]: T.target, [other]: Math.min(s[other], T.target - 1) });
}

async function toggleDQ(name) {
    const p = activeRecord()?.players.find((x) => x.name === name);
    if (!p) return;
    if (!p.isDQ) {
        const ok = await confirmDialog(`Disqualify ${name}?`, 'Their remaining matches are forfeited. You can reinstate them or undo this at any time.', 'Disqualify', true);
        if (!ok) return;
    }
    mutate(p.isDQ ? `reinstate ${name}` : `disqualify ${name}`, (r) => {
        const pl = r.players.find((x) => x.name === name);
        pl.isDQ = !pl.isDQ;
    });
}

async function removePlayer(name) {
    const rec = activeRecord();
    const reshapes = rec.format !== 'rr';
    const ok = await confirmDialog(
        `Remove ${name}?`,
        reshapes ? 'The bracket is rebuilt from the remaining players. Results stay wherever both players in a match are unchanged. You can undo this.'
            : 'Their matches are removed from the schedule. You can undo this.',
        'Remove', true,
    );
    if (!ok) return;
    mutate(`remove ${name}`, (r) => {
        r.players = r.players.filter((p) => p.name !== name).sort((a, b) => a.seed - b.seed).map((p, i) => ({ ...p, seed: i + 1 }));
        if (reshapes) {
            Object.keys(r.matchScores).forEach((k) => {
                const m = r.matchScores[k];
                if (cleanPlayerName(m.player1) === name || cleanPlayerName(m.player2) === name) delete r.matchScores[k];
            });
        }
    });
}

async function addPlayer() {
    const rec = activeRecord();
    const name = (await dialog({
        title: 'Add Player',
        body: rec.format === 'rr' ? 'They’ll be added to the schedule. Existing results are kept.' : 'They’ll join as the lowest seed. Results stay wherever matchups are unchanged.',
        input: { placeholder: 'Player name' }, ok: 'Add', iconName: 'user-plus', tone: 'green',
    }))?.trim();
    if (!name) return;
    if (rec.players.some((p) => p.name.toLowerCase() === name.toLowerCase())) { alertDialog('Name taken', `${name} is already in this tournament.`); return; }
    mutate(`add ${name}`, (r) => { r.players.push({ name, seed: r.players.length + 1, isDQ: false }); });
}

async function renamePlayer(oldName) {
    const rec = activeRecord();
    const name = (await dialog({ title: 'Rename Player', input: { value: oldName }, ok: 'Rename' }))?.trim();
    if (!name || name === oldName) return;
    if (rec.players.some((p) => p.name.toLowerCase() === name.toLowerCase() && p.name !== oldName)) { alertDialog('Name taken', `${name} is already in this tournament.`); return; }
    mutate(`rename ${oldName}`, (r) => {
        const oldNames = r.players.map((p) => p.name);
        const newNames = oldNames.map((n) => (n === oldName ? name : n));
        const swap = (label) => {
            if (!label) return label;
            const { seed, name: n } = splitSeed(label);
            if (n !== oldName) return label;
            return seed ? `(#${seed}) ${name}` : name;
        };
        if (r.format === 'rr') {
            const before = roundRobinSchedule(oldNames).flatMap((x) => x.matches);
            const after = roundRobinSchedule(newNames).flatMap((x) => x.matches);
            const moved = {};
            before.forEach((m, i) => {
                if (m.type !== 'match' || !r.matchScores[m.id]) return;
                moved[after[i].id] = r.matchScores[m.id];
                delete r.matchScores[m.id];
            });
            Object.assign(r.matchScores, moved);
        }
        Object.values(r.matchScores).forEach((m) => { m.player1 = swap(m.player1); m.player2 = swap(m.player2); });
        r.players.forEach((p) => { if (p.name === oldName) p.name = name; });
    });
}

async function renameTournament() {
    const rec = activeRecord();
    const name = (await dialog({ title: 'Rename Tournament', input: { value: rec.name }, ok: 'Rename' }))?.trim();
    if (!name || name === rec.name) return;
    mutate('rename tournament', (r) => { r.name = name; });
}

async function resetScores() {
    const ok = await confirmDialog('Reset all scores?', 'Every result in this tournament is cleared. You can undo this.', 'Reset', true);
    if (!ok) return;
    mutate('reset scores', (r) => { r.matchScores = {}; r.completedAt = null; });
}

async function repairRound() {
    const rp = T?.repairableSwissRound();
    if (!rp) return;
    const ok = await confirmDialog(`Re-pair Round ${rp.index + 1}?`, 'Pairings are regenerated from the current standings. Use this after correcting an earlier result.', 'Re-pair');
    if (!ok) return;
    mutate(`re-pair round ${rp.index + 1}`, (r) => { rp.ids.forEach((id) => delete r.matchScores[id]); });
}

// ---------- Player card ----------
function openPlayerCard(name) {
    const rec = activeRecord();
    if (!rec || !T) return;
    const p = rec.players.find((x) => x.name === name);
    if (!p) return;
    const st = T.playerStats(name);
    const rank = T.finalRankings().find((r) => r.name === name);
    $('#pc-avatar').textContent = name.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
    $('#pc-name').textContent = name;
    $('#pc-sub').textContent = `Seed ${p.seed}${p.isDQ ? ' · Disqualified' : ''}${rank && !p.isDQ && !rank.alive ? ` · ${rank.placeLabel}` : rank?.alive ? ' · Still in' : ''}`;
    const tile = (v, l) => `<div class="stat"><b>${v}</b><span>${l}</span></div>`;
    $('#pc-stats').innerHTML = [
        tile(`${st.wins}–${st.losses}`, 'Series'),
        tile(`${st.winRate}%`, 'Game win rate'),
        tile(`${st.gameWins}–${st.gameLosses}`, 'Games'),
        tile(st.points, 'Points'),
        tile(st.sweeps, `${rec.winThreshold}–0 sweeps`),
        tile(st.history.filter((h) => !h.result).length, 'Still to play'),
    ].join('');
    $('#pc-form').innerHTML = st.form.length ? formDots(st.form, 10) : '<span class="small tertiary">No results yet</span>';
    $('#pc-history').innerHTML = st.history.length ? st.history.map((h) => `
        <div class="h-match">
            <div><small>${esc(h.round)}</small>vs ${esc(h.opponent)}</div>
            <b>${h.result ? `${h.for}–${h.against}` : '<span class="tertiary">–</span>'}</b>
            <span class="res ${h.result || ''}">${h.result || '·'}</span>
        </div>`).join('') : '<span class="small tertiary">No matches yet</span>';
    openModal('modal-player');
}

// ---------- Final results ----------
function showFinalResults() {
    const rec = activeRecord();
    if (!rec || !T) return;
    const rows = T.finalRankings();
    $('#final-sub').textContent = `${rec.name} · ${formatLabel(rec.format, true)} · ${rec.players.length} players`;
    const at = (place) => rows.filter((r) => !r.isDQ && r.place === place);
    const step = (place) => {
        const list = at(place);
        if (!list.length) return `<div class="place p${place}" style="visibility:hidden"><div class="pedestal"></div></div>`;
        const top = place === 1 ? `<div class="trophy">${icon('trophy')}</div>` : '';
        return `<div class="place p${place}">${top}${rankBadge(list[0])}<b>${list.map((r) => esc(r.name)).join(' & ')}</b><small>${list[0].wins}–${list[0].losses}</small><div class="pedestal"></div></div>`;
    };
    $('#final-podium').innerHTML = step(2) + step(1) + step(3);
    $('#final-list').innerHTML = rows.map((r) => `
        <div class="list-row">${rankBadge(r)}<div class="grow"><div class="title">${esc(r.name)}</div></div><span class="secondary small">${r.wins}–${r.losses} · ${r.diff > 0 ? '+' : ''}${r.diff}</span></div>`).join('');
    openModal('modal-final');
}

function resultsText(rec, t) {
    const lines = [rec.name, `Format: ${formatLabel(rec.format, true)}`, `Series: ${bestOfLabel(t)} (first to ${rec.winThreshold})`, `Exported: ${new Date().toLocaleString()}`, '', 'Final Positions'];
    t.finalRankings().forEach((r) => {
        lines.push(`${r.placeLabel}. ${r.name}${r.isDQ ? ' (DQ)' : ''} - ${r.wins}-${r.losses}, points ${r.points}, diff ${r.diff > 0 ? '+' : ''}${r.diff}${t.format === 'swiss' ? `, Buchholz ${r.buchholz}` : ''}`);
    });
    lines.push('', 'Matches');
    t.matches().forEach((m) => {
        if (isTBD(m.p1) || isTBD(m.p2) || isBye(m.p1) || isBye(m.p2)) return;
        const s = t.score(m.id, m.p1, m.p2);
        lines.push(`${m.round}: ${cleanPlayerName(m.p1)} ${s.p1}-${s.p2} ${cleanPlayerName(m.p2)}`);
    });
    return lines.join('\n');
}

function resultsCsv(rec, t) {
    const q = (v) => `"${String(v).replace(/"/g, '""')}"`;
    const out = [['Place', 'Player', 'Seed', 'Wins', 'Losses', 'Game Wins', 'Game Losses', 'Diff', 'Points', 'Buchholz', 'DQ'].map(q).join(',')];
    t.finalRankings().forEach((r) => out.push([r.placeLabel, r.name, r.seed, r.wins, r.losses, r.gameWins, r.gameLosses, r.diff, r.points, r.buchholz, r.isDQ ? 'yes' : ''].map(q).join(',')));
    return out.join('\r\n');
}

async function exportResults(kind = 'txt') {
    closePopMenus();
    const rec = activeRecord();
    if (!rec) { toast('Open a tournament first.', 'info'); return; }
    const t = engineFor(rec);
    try {
        const path = kind === 'csv'
            ? await platform.saveFile(`${sanitizeFileName(rec.name)}_results.csv`, '﻿' + resultsCsv(rec, t), 'CSV spreadsheet', ['csv'])
            : await platform.saveFile(`${sanitizeFileName(rec.name)}_final_results.txt`, resultsText(rec, t), 'Text file', ['txt']);
        if (path) toast('Results exported');
    } catch (e) { toast(`Export failed: ${e?.message || e}`, 'err'); }
}

// ---------- Print ----------
function printBracket() {
    closePopMenus();
    const rec = activeRecord();
    if (!rec) { toast('Open a tournament first.', 'info'); return; }
    const t = engineFor(rec);
    const nm = (l) => esc(isTBD(l) ? prettyTBD(l) : isBye(l) ? 'Bye' : cleanPlayerName(l));
    const pcol = (sec) => `<div class="pcol"><h3>${esc(sec.title)}</h3><div class="pcol-body">${sec.matches.map((m) => {
        if (m.type === 'bye') return `<div class="pcard"><div>${esc(m.active)} — bye</div></div>`;
        const s = t.score(m.id, m.p1, m.p2);
        const pend = isTBD(m.p1) || isTBD(m.p2) || isBye(m.p1) || isBye(m.p2);
        const ln = (l, sc, w) => `<div class="${w ? 'w' : ''}"><span>${nm(l)}</span><span>${pend ? '' : sc}</span></div>`;
        return `<div class="pcard">${ln(m.p1, s.p1, !pend && s.p1 === t.target)}${ln(m.p2, s.p2, !pend && s.p2 === t.target)}</div>`;
    }).join('')}</div></div>`;

    let visual = '';
    const secs = t.sections();
    if (rec.format === 'rr') {
        const names = [...t.players].sort((a, b) => a.seed - b.seed).map((p) => p.name);
        const cell = {};
        t.matches().forEach((m) => {
            const s = t.score(m.id, m.p1, m.p2);
            if (s.p1 !== t.target && s.p2 !== t.target) return;
            cell[`${m.p1}|${m.p2}`] = `${s.p1}–${s.p2}`;
            cell[`${m.p2}|${m.p1}`] = `${s.p2}–${s.p1}`;
        });
        visual = `<h2>Crosstable</h2><table><thead><tr><th></th>${names.map((n, i) => `<th>${i + 1}</th>`).join('')}</tr></thead><tbody>${names.map((a, i) => `<tr><th>${i + 1}. ${esc(a)}</th>${names.map((b) => `<td>${a === b ? '—' : cell[`${a}|${b}`] || ''}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
    } else if (rec.format === 'swiss') visual = `<h2>Rounds</h2><div class="pbracket">${secs.map(pcol).join('')}</div>`;
    else if (rec.format === 'se') visual = `<h2>Bracket</h2><div class="pbracket">${secs.map(pcol).join('')}</div>`;
    else visual = `<h2>Winners bracket &amp; finals</h2><div class="pbracket">${secs.filter((s) => s.kind !== 'losers').map(pcol).join('')}</div>
        <h2>Losers bracket</h2><div class="pbracket">${secs.filter((s) => s.kind === 'losers').map(pcol).join('')}</div>`;

    const matchRows = t.matches().map((m) => {
        const s = t.score(m.id, m.p1, m.p2);
        const pend = isTBD(m.p1) || isTBD(m.p2) || isBye(m.p1) || isBye(m.p2);
        const done = !pend && (s.p1 === t.target || s.p2 === t.target);
        return `<tr><td>${esc(m.round)}</td><td>${nm(m.p1)}</td><td>${done ? `${s.p1} – ${s.p2}` : ''}</td><td>${nm(m.p2)}</td></tr>`;
    }).join('');
    const standRows = t.finalRankings().map((r) => `<tr><td>${esc(r.placeLabel)}</td><td>${esc(r.name)}</td><td>${r.wins}–${r.losses}</td><td>${r.diff > 0 ? '+' : ''}${r.diff}</td><td>${r.points}</td></tr>`).join('');
    $('#print-root').innerHTML = `
        <h1>${esc(rec.name)}</h1>
        <div class="pmeta">${formatLabel(rec.format, true)} · ${bestOfLabel(t)} · ${rec.players.length} players · Printed ${esc(new Date().toLocaleString())}</div>
        <h2>Standings</h2>
        <table><thead><tr><th>Place</th><th>Player</th><th>Record</th><th>Diff</th><th>Points</th></tr></thead><tbody>${standRows}</tbody></table>
        ${visual}
        <h2>Matches</h2>
        <table><thead><tr><th>Round</th><th>Player 1</th><th>Score</th><th>Player 2</th></tr></thead><tbody>${matchRows || '<tr><td colspan="4">No matches.</td></tr>'}</tbody></table>`;
    setTimeout(() => window.print(), 60);
}

// ============================================================================
// History
// ============================================================================

function renderHistory() {
    const q = $('#history-search').value.trim().toLowerCase();
    const sort = $('#history-sort').value;
    const summaries = new Map(state.history.map((r) => {
        const t = engineFor(r);
        return [r.id, { p: t.progress(), done: t.isComplete() }];
    }));
    let list = [...state.history];
    if (q) list = list.filter((r) => r.name.toLowerCase().includes(q) || r.players.some((p) => p.name.toLowerCase().includes(q)));
    if (historyFilter !== 'all') list = list.filter((r) => summaries.get(r.id).done === (historyFilter === 'done'));
    list.sort((a, b) => {
        if (sort === 'name') return a.name.localeCompare(b.name);
        if (sort === 'created') return (b.createdAt || '').localeCompare(a.createdAt || '');
        return (b.updatedAt || '').localeCompare(a.updatedAt || '');
    });
    const total = state.history.length;
    const done = [...summaries.values()].filter((s) => s.done).length;
    $('#history-sub').textContent = total ? `${total} tournament${total === 1 ? '' : 's'} · ${done} completed` : 'Nothing here yet';
    const box = $('#history-list');
    if (!total) {
        box.innerHTML = `<div class="welcome glass-strong"><div class="brand-mark">${icon('history')}</div><h2>No tournaments yet</h2><p>Finished and in-progress tournaments are kept here automatically.</p><button class="btn prominent large" data-action="new-tournament">${icon('plus')} New Tournament</button></div>`;
        return;
    }
    if (!list.length) { box.innerHTML = `<div class="empty">${icon('search')}<p>Nothing matches.</p></div>`; return; }
    box.innerHTML = `<div class="list">${list.map((r) => {
        const s = summaries.get(r.id);
        return `<div class="list-row history-row indent ${r.id === state.activeId ? 'is-active' : ''}">
            ${formatIcon(r.format)}
            <div class="grow">
                <div class="title">${esc(r.name)}</div>
                <div class="chips">
                    <span class="chip">${formatLabel(r.format)}</span>
                    <span class="chip">${r.players.length} players</span>
                    <span class="chip ${s.done ? 'green' : 'blue'}">${s.done ? 'Complete' : `${s.p.done}/${s.p.total} played`}</span>
                    <span class="small tertiary">${esc(fmtDate(r.updatedAt) || r.lastUpdated || r.date)}</span>
                </div>
            </div>
            <div class="acts">
                <button class="icon-btn" data-action="quick-view" data-id="${esc(r.id)}" title="Quick look">${icon('eye')}</button>
                <button class="icon-btn" data-action="rematch" data-id="${esc(r.id)}" title="Run again with this roster">${icon('repeat')}</button>
                <button class="icon-btn" data-action="export-record" data-id="${esc(r.id)}" title="Export backup">${icon('upload')}</button>
                <button class="icon-btn danger" data-action="delete-record" data-id="${esc(r.id)}" title="Delete">${icon('trash')}</button>
                <button class="btn small prominent" data-action="open-record" data-id="${esc(r.id)}">Open</button>
            </div>
        </div>`;
    }).join('')}</div>`;
}

function quickView(id) {
    const rec = findRecord(id);
    if (!rec) return;
    const t = engineFor(rec);
    $('#qv-title').textContent = rec.name;
    $('#qv-meta').innerHTML = `${metaChips(t, rec)}<span class="small tertiary">Updated ${esc(fmtDate(rec.updatedAt))}</span>`;
    const top = t.finalRankings().slice(0, 5);
    $('#qv-standings').innerHTML = top.length ? `<div class="list">${top.map((r) => `<div class="list-row">${rankBadge(r)}<div class="grow"><div class="title">${esc(r.name)}</div></div><span class="secondary small">${r.wins}–${r.losses}</span></div>`).join('')}</div>` : '<span class="small tertiary">No results yet</span>';
    $('#qv-roster').innerHTML = [...rec.players].sort((a, b) => a.seed - b.seed).map((p) => `<span class="chip" ${p.isDQ ? 'style="text-decoration:line-through;opacity:.6"' : ''}>${p.seed}. ${esc(p.name)}</span>`).join('');
    $('#qv-actions').innerHTML = `<button class="btn" data-action="rematch" data-id="${esc(rec.id)}">${icon('repeat')} Rematch</button><button class="btn prominent" data-action="open-record" data-id="${esc(rec.id)}">Open</button>`;
    openModal('modal-quick');
}

function rematch(id) {
    const rec = findRecord(id);
    if (!rec) return;
    startSetup({
        step: 'players',
        name: `${rec.name.replace(/\s*\(Rematch( \d+)?\)$/, '')} (Rematch)`,
        format: rec.format,
        firstTo: rec.winThreshold,
        thirdPlace: rec.thirdPlace,
        swissRounds: rec.swissRounds,
        roster: [...rec.players].sort((a, b) => a.seed - b.seed).map((p) => p.name),
    });
}

async function deleteRecord(id) {
    const rec = findRecord(id);
    if (!rec) return;
    const ok = await confirmDialog(`Delete “${rec.name}”?`, 'You can bring it back with Undo right after.', 'Delete', true);
    if (!ok) return;
    const index = state.history.indexOf(rec);
    const wasActive = state.activeId === id;
    state.history.splice(index, 1);
    if (wasActive) { state.activeId = null; T = null; }
    persist();
    renderHistory();
    renderChrome();
    syncLive();
    toast(`Deleted ${rec.name}`, 'info', {
        action: 'Undo', timeout: 7000,
        onAction: () => {
            state.history.splice(index, 0, rec);
            if (wasActive) { state.activeId = id; T = engineFor(rec); }
            persist();
            if (currentView === 'history') renderHistory();
            renderChrome();
            syncLive();
        },
    });
}

async function exportAllZip() {
    if (!state.history.length) { toast('No tournaments to export.', 'info'); return; }
    try {
        const files = [];
        for (let i = 0; i < state.history.length; i++) {
            const r = state.history[i];
            files.push({ name: `${String(i + 1).padStart(2, '0')}_${sanitizeFileName(r.name)}_log.txt`, content: await encodePackage(recordToPackage(r)) });
        }
        const path = await platform.saveFile(`tournament_history_logs_${new Date().toISOString().slice(0, 10)}.zip`, createZip(files), 'Zip archive', ['zip']);
        if (path) toast(`Exported ${files.length} tournament${files.length === 1 ? '' : 's'}`);
    } catch (e) { toast(`Export failed: ${e?.message || e}`, 'err'); }
}

// ============================================================================
// Import / export
// ============================================================================

function renderData(preselectId) {
    const sel = $('#export-select');
    const list = [...state.history].sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
    sel.innerHTML = list.length
        ? list.map((r) => `<option value="${esc(r.id)}">${esc(r.name)} — ${formatLabel(r.format)}, ${r.players.length} players</option>`).join('')
        : '<option value="">No tournaments yet</option>';
    const want = preselectId || state.activeId;
    if (want && list.some((r) => r.id === want)) sel.value = want;
    $('#export-output').value = '';
    $('#legacy-btn').style.display = platform.isTauri ? '' : 'none';
}

async function buildExportCode() {
    const rec = findRecord($('#export-select').value);
    if (!rec) { toast('Choose a tournament to export.', 'info'); return null; }
    const pw = $('#export-password').value;
    const code = await encodePackage(recordToPackage(rec, !!pw), pw);
    $('#export-output').value = code;
    return { rec, code, encrypted: !!pw };
}

async function exportToFile(recordId) {
    closePopMenus();
    try {
        let out;
        if (recordId) {
            const rec = findRecord(recordId);
            if (!rec) return;
            out = { rec, code: await encodePackage(recordToPackage(rec)), encrypted: false };
        } else {
            out = await buildExportCode();
        }
        if (!out) return;
        const path = await platform.saveFile(`${sanitizeFileName(out.rec.name)}_${out.encrypted ? 'encrypted_' : ''}backup.txt`, out.code, 'Tournament backup', ['txt']);
        if (path) toast('Backup saved');
    } catch (e) { toast(`Export failed: ${e?.message || e}`, 'err'); }
}

async function exportToClipboard() {
    try {
        const out = await buildExportCode();
        if (!out) return;
        await copyText(out.code, $('#export-output'));
        toast(out.encrypted ? 'Encrypted backup code copied' : 'Backup code copied');
    } catch (e) { toast(`Export failed: ${e?.message || e}`, 'err'); }
}

async function copyText(text, fallbackEl) {
    try { await navigator.clipboard.writeText(text); }
    catch {
        const ta = fallbackEl || Object.assign(document.createElement('textarea'), { value: text });
        if (!fallbackEl) document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        if (!fallbackEl) ta.remove();
    }
}

async function exportFullBackup() {
    const payload = { kind: 'bracket-maker-full-backup', version: 2, exportedAt: new Date().toISOString(), settings: state.settings, history: state.history };
    try {
        const path = await platform.saveFile(`bracket_maker_backup_${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(payload, null, 2), 'Bracket Maker backup', ['json']);
        if (path) toast('Full backup saved');
    } catch (e) { toast(`Export failed: ${e?.message || e}`, 'err'); }
}

async function decodeWithPrompt(text, label, presetPassword = '') {
    try {
        return await decodePackage(text, presetPassword);
    } catch (e) {
        if (!(e instanceof PasswordRequiredError)) throw e;
        for (;;) {
            const pw = await dialog({ title: 'Password Required', body: `${label} is encrypted.`, input: { type: 'password', placeholder: 'Password' }, ok: 'Unlock', iconName: 'lock', tone: 'orange' });
            if (pw === null) throw new Error('Skipped (no password)');
            try { return await decodePackage(text, pw); } catch (err) {
                if (!/Wrong password/.test(err.message)) throw err;
                toast('Wrong password, try again', 'err', { timeout: 2500 });
            }
        }
    }
}

function mergeRecords(records) {
    let added = 0, updated = 0;
    records.forEach((raw) => {
        const r = normalizeRecord(raw);
        if (r.players.length < 2) return;
        const existing = findRecord(r.id);
        if (!existing) { state.history.push(r); added++; return; }
        if ((r.updatedAt || '') > (existing.updatedAt || '')) { Object.assign(existing, r); updated++; }
    });
    return { added, updated };
}

async function importText(text, label, results, password = '') {
    const trimmed = text.trim().replace(/^﻿/, '');
    if (trimmed.startsWith('{')) {
        const obj = JSON.parse(trimmed);
        if (Array.isArray(obj.history)) {
            const { added, updated } = mergeRecords(obj.history);
            results.added += added;
            results.updated += updated;
            return;
        }
        const rec = packageToRecord(obj);
        state.history.push(rec);
        results.added++;
        results.last = rec;
        return;
    }
    const rec = packageToRecord(await decodeWithPrompt(trimmed, label, password));
    state.history.push(rec);
    results.added++;
    results.last = rec;
}

async function importFiles(files, errors = []) {
    const results = { added: 0, updated: 0, failed: [...errors], last: null };
    for (const f of files) {
        try {
            if (isZip(f.bytes)) {
                const entries = (await readZip(f.bytes)).filter((e) => /\.(txt|thub|json)$/i.test(e.name));
                if (!entries.length) throw new Error('No backups found in this archive.');
                for (const e of entries) {
                    try { await importText(e.text, e.name, results); } catch (err) { results.failed.push(`${e.name}: ${err.message}`); }
                }
            } else {
                await importText(new TextDecoder().decode(f.bytes), f.name, results);
            }
        } catch (e) {
            results.failed.push(`${f.name}: ${e.message}`);
        }
    }
    finishImport(results);
}

function finishImport(results) {
    if (results.added || results.updated) {
        persist();
        if (currentView === 'history') renderHistory();
        if (currentView === 'data') renderData();
        if (currentView === 'home') renderHome();
        renderChrome();
        const parts = [];
        if (results.added) parts.push(`imported ${results.added}`);
        if (results.updated) parts.push(`updated ${results.updated}`);
        const msg = `${parts.join(', ').replace(/^./, (c) => c.toUpperCase())} tournament${results.added + results.updated === 1 ? '' : 's'}`;
        const last = results.last;
        toast(msg, 'ok', last ? { action: 'Open', onAction: () => openRecord(last.id), timeout: 6000 } : {});
    }
    if (results.failed.length) {
        alertDialog(results.added || results.updated ? 'Some files couldn’t be imported' : 'Import failed', results.failed.slice(0, 8).join('\n'));
    }
}

async function importFromPicker() {
    try {
        const files = await platform.pickImportFiles();
        if (files.length) await importFiles(files);
    } catch (e) { toast(`Import failed: ${e?.message || e}`, 'err'); }
}

async function importCode() {
    const raw = $('#import-input').value.trim();
    if (!raw) { toast('Paste a backup code first.', 'info'); return; }
    const results = { added: 0, updated: 0, failed: [], last: null };
    try {
        await importText(raw, 'This code', results, $('#import-password').value);
        $('#import-input').value = '';
        $('#import-password').value = '';
    } catch (e) {
        results.failed.push(e.message);
    }
    finishImport(results);
}

async function importLegacy(silent = false) {
    let profiles = [];
    try { profiles = await platform.findLegacyData(); } catch (e) { if (!silent) toast(`Couldn’t read old data: ${e}`, 'err'); return; }
    let records = [];
    let settings = null;
    let theme = null;
    let active = null;
    for (const p of profiles) {
        try { const h = JSON.parse(p.values.tournament_history_v3 || '[]'); if (Array.isArray(h)) records = records.concat(h); } catch { /* ignore */ }
        try { if (p.values.tournament_hub_settings_v1) settings = JSON.parse(p.values.tournament_hub_settings_v1); } catch { /* ignore */ }
        if (p.values.h_theme) theme = p.values.h_theme;
        if (p.values.active_tournament_id) active = p.values.active_tournament_id;
    }
    const { added, updated } = mergeRecords(records);
    if (silent) {
        if (settings) state.settings = normalizeSettings({ ...state.settings, ...settings, theme: state.settings.theme });
        if (theme === 'dark' || theme === 'light') state.settings.theme = theme;
        if (active && findRecord(active)) state.activeId = active;
        applyTheme();
    }
    state.legacyChecked = true;
    persist();
    if (added || updated) {
        toast(`Imported ${added + updated} tournament${added + updated === 1 ? '' : 's'} from the previous version`, 'ok', { timeout: 6000 });
        if (currentView === 'home') renderHome();
        if (currentView === 'data') renderData();
        renderChrome();
    } else if (!silent) {
        toast(profiles.length ? 'Nothing new to import from the old app.' : 'No data from the old Bracket Maker app was found.', 'info');
    }
}

// ============================================================================
// Live website
// ============================================================================

function livePayload() {
    const rec = activeRecord();
    if (!rec) return null;
    return {
        name: rec.name, format: rec.format, winThreshold: rec.winThreshold, players: rec.players, matchScores: rec.matchScores,
        swissRounds: rec.swissRounds, thirdPlace: rec.thirdPlace, updatedAt: rec.updatedAt, completedAt: rec.completedAt,
    };
}

function pushLive() {
    if (live.unsupported || !live.running) return;
    platform.shareUpdate(JSON.stringify(livePayload())).catch((e) => console.warn('live update failed', e));
}

/** Start/stop the server to match settings, then push the current tournament. */
async function syncLive() {
    if (live.unsupported) { renderLiveCard(); return; }
    const want = state.settings.liveShare && !!activeRecord();
    try {
        if (want) {
            live = { ...live, ...(await platform.shareStart(state.settings.livePort)), error: null };
        } else if (live.running && !state.settings.liveShare) {
            await platform.shareStop();
            live = { ...live, running: false, urls: [], qr_svg: null, port: 0 };
        }
    } catch (e) {
        live = { ...live, running: false, error: String(e?.message || e) };
    }
    pushLive();
    renderLiveCard();
    if (currentView === 'active') renderToolbar();
    if (currentView === 'settings') renderSettings();
    if (currentView === 'home') renderHome();
}

function renderLiveCard() {
    const card = $('#live-card');
    if (live.unsupported) { card.style.display = 'none'; return; }
    card.style.display = '';
    const url = live.urls[0] || '';
    if (live.running) {
        card.innerHTML = `
            <div class="live-head"><span class="live-dot on"></span>Live website</div>
            <span class="live-url" title="${esc(url)}">${esc(url.replace('http://', ''))}</span>
            <div class="row">
                <button class="btn small" data-action="open-live">${icon('qr')} QR Code</button>
                <button class="btn small" data-action="copy-live-url">${icon('copy')} Copy</button>
            </div>`;
    } else {
        const sub = live.error ? esc(live.error)
            : state.settings.liveShare ? 'Starts when a tournament is open.' : 'Let others follow the open tournament on this network.';
        card.innerHTML = `
            <div class="live-head"><span class="live-dot"></span>Live website</div>
            <div class="live-sub">${sub}</div>
            ${state.settings.liveShare ? '' : `<button class="btn small" data-action="toggle-live">${icon('broadcast')} Turn On</button>`}`;
    }
}

async function openLiveSheet() {
    if (live.unsupported) { toast('The live website is available in the desktop app.', 'info'); return; }
    if (!state.settings.liveShare) { state.settings.liveShare = true; persist(); }
    if (!activeRecord()) { toast('Open a tournament to share it.', 'info'); }
    else if (!live.running) await syncLive();
    if (!live.running) {
        if (live.error) alertDialog('Couldn’t start the live website', live.error);
        return;
    }
    $('#live-qr').innerHTML = live.qr_svg || '';
    $('#live-url').textContent = live.urls[0] || '';
    $('#live-alt').textContent = live.urls.length > 1 ? `Also: ${live.urls.slice(1).join(', ')}` : `Port ${live.port} · read-only`;
    $('#live-toggle-btn').textContent = 'Stop Sharing';
    openModal('modal-live');
}

async function toggleLive() {
    state.settings.liveShare = !state.settings.liveShare;
    persist();
    if (!state.settings.liveShare) closeModal('modal-live');
    await syncLive();
    toast(state.settings.liveShare ? (live.running ? 'Live website is on' : 'Live website starts when a tournament is open') : 'Live website stopped', 'info');
}

// ============================================================================
// Settings
// ============================================================================

function renderSettings() {
    const s = state.settings;
    applyTheme();
    $('#setting-format').value = s.defaultFormat;
    $('#setting-first-to').value = String(s.defaultFirstTo);
    $('#setting-roster-enabled').checked = s.defaultRosterEnabled;
    if (document.activeElement !== $('#setting-roster')) $('#setting-roster').value = s.defaultRoster.join('\n');
    $('#setting-live').checked = s.liveShare;
    if (document.activeElement !== $('#setting-port')) $('#setting-port').value = String(s.livePort);
    $('#setting-live-status').textContent = live.unsupported ? 'Only available in the desktop app'
        : live.running ? `Running at ${live.urls[0]}${live.port !== s.livePort ? ` (port ${s.livePort} was busy)` : ''}`
            : live.error || (s.liveShare ? 'Starts when a tournament is open' : 'Off');
    $('#reveal-btn').textContent = platform.isMac ? 'Show in Finder' : 'Show Folder';
}

function initSettings() {
    $('#setting-format').addEventListener('change', (e) => { state.settings.defaultFormat = e.target.value; persist(); });
    $('#setting-first-to').addEventListener('change', (e) => { state.settings.defaultFirstTo = parseInt(e.target.value, 10) || 3; persist(); });
    $('#setting-roster-enabled').addEventListener('change', (e) => { state.settings.defaultRosterEnabled = e.target.checked; persist(); });
    let t;
    $('#setting-roster').addEventListener('input', (e) => {
        clearTimeout(t);
        t = setTimeout(() => {
            const roster = uniqueNames(e.target.value.split('\n'));
            state.settings.defaultRoster = roster.length ? roster : [...BUILT_IN_ROSTER];
            persist();
        }, 400);
    });
    $('#setting-theme').addEventListener('click', (e) => { const b = e.target.closest('[data-theme-choice]'); if (b) setTheme(b.dataset.themeChoice); });
    $('#setting-live').addEventListener('change', (e) => { state.settings.liveShare = e.target.checked; persist(); syncLive(); });
    $('#setting-port').addEventListener('change', (e) => {
        const port = Number(e.target.value);
        if (!(port >= 1024 && port <= 65000)) { e.target.value = String(state.settings.livePort); toast('Use a port between 1024 and 65000.', 'err'); return; }
        state.settings.livePort = port;
        persist();
        syncLive();
    });
}

// ============================================================================
// Events
// ============================================================================

const actions = {
    go: (el) => go(el.dataset.view),
    tab: (el) => switchTab(el.dataset.tab),
    'toggle-theme': toggleTheme,
    'new-tournament': () => startSetup(),
    'setup-next': setupNext,
    'setup-back': setupBack,
    'launch-tournament': launchTournament,
    'remove-entry': (el) => {
        el.closest('.entry').remove();
        syncRosterFromInputs();
        ensureTrailingEntry();
        refreshEntryMeta();
    },
    'use-default-roster': () => { setup.roster = [...state.settings.defaultRoster]; renderPlayerEntry(); },
    'clear-roster': () => { setup.roster = []; renderPlayerEntry(); $('#setup-player-list .pe-input')?.focus(); },
    'load-saved-roster': () => {
        const rec = findRecord($('#saved-roster-select').value);
        if (!rec) { toast('Choose a past tournament first.', 'info'); return; }
        setup.roster = [...rec.players].sort((a, b) => a.seed - b.seed).map((p) => p.name);
        renderPlayerEntry();
        toast(`Loaded ${setup.roster.length} players`);
    },
    'checkin-all': (el) => { setup.roster.forEach((n) => { setup.checked[n] = el.dataset.value === '1'; }); renderCheckIn(); },
    'randomize-seeds': () => {
        const a = setup.seeds;
        for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
        renderSeeding();
    },
    'alpha-seeds': () => { setup.seeds.sort((a, b) => a.localeCompare(b)); renderSeeding(); },
    'seed-move': (el) => moveSeed(Number(el.dataset.i), Number(el.dataset.i) + Number(el.dataset.d)),
    'open-record': (el) => openRecord(el.dataset.id),
    'quick-view': (el) => quickView(el.dataset.id),
    rematch: (el) => rematch(el.dataset.id),
    'delete-record': (el) => deleteRecord(el.dataset.id),
    'export-record': (el) => exportToFile(el.dataset.id),
    'export-all-zip': exportAllZip,
    'rename-tournament': renameTournament,
    undo, redo,
    'toggle-menu': (el) => { const m = document.getElementById(el.dataset.menu); const on = !m.classList.contains('on'); closePopMenus(); m.classList.toggle('on', on); },
    print: printBracket,
    'export-results': () => exportResults('txt'),
    'export-results-csv': () => exportResults('csv'),
    'export-active-backup': () => exportToFile(state.activeId),
    'reset-scores': () => { closePopMenus(); resetScores(); },
    'repair-round': repairRound,
    'show-final': showFinalResults,
    player: (el) => openPlayerCard(el.dataset.name),
    'toggle-dq': (el) => toggleDQ(el.dataset.name),
    'remove-player': (el) => removePlayer(el.dataset.name),
    'rename-player': (el) => renamePlayer(el.dataset.name),
    'add-player': addPlayer,
    'me-step': (el) => meStep(el.dataset.key, Number(el.dataset.d)),
    'me-win': (el) => meWin(el.dataset.key),
    'me-clear': () => { if (editingMatch) setScore(editingMatch, { p1: 0, p2: 0 }); },
    'close-modal': (el) => closeModal(el.closest('.modal')?.id),
    'export-file': () => exportToFile(),
    'export-copy': exportToClipboard,
    'export-full-backup': exportFullBackup,
    'import-files': importFromPicker,
    'import-code': importCode,
    'import-legacy': () => importLegacy(false),
    'reveal-data': async () => { try { await platform.revealDataFolder(); } catch (e) { toast(String(e?.message || e), 'err'); } },
    'open-live': openLiveSheet,
    'toggle-live': toggleLive,
    'copy-live-url': async () => { if (live.urls[0]) { await copyText(live.urls[0]); toast('Link copied'); } },
    'open-live-url': () => { if (live.urls[0]) platform.openExternal(live.urls[0]); },
};

function handleMenu(id) {
    const map = {
        new_tournament: () => startSetup(),
        import: () => { go('data'); importFromPicker(); },
        export: () => { go('data'); renderData(state.activeId); },
        export_results: () => exportResults('txt'),
        print: printBracket,
        settings: () => go('settings'),
        undo, redo,
        find: () => {
            if (currentView === 'history') { $('#history-search').focus(); return; }
            if (!activeRecord()) return;
            if (currentView !== 'active') go('active');
            switchTab('matches');
            setTimeout(() => $('#search-input').focus(), 30);
        },
        bracket_map: () => { if (!activeRecord()) return; if (currentView !== 'active') go('active'); switchTab('bracket'); },
        theme_system: () => setTheme('system'),
        theme_light: () => setTheme('light'),
        theme_dark: () => setTheme('dark'),
        toggle_theme: toggleTheme,
        go_home: () => go('home'),
        go_active: () => go('active'),
        go_history: () => go('history'),
        go_data: () => go('data'),
        live_share: openLiveSheet,
    };
    map[id]?.();
}

function initEvents() {
    document.addEventListener('click', (e) => {
        const el = e.target.closest('[data-action]');
        if (!e.target.closest('.menu-wrap')) closePopMenus();
        if (!el || el.disabled) return;
        const fn = actions[el.dataset.action];
        if (fn) { e.preventDefault(); fn(el, e); }
    });
    $$('.modal').forEach((m) => m.addEventListener('mousedown', (e) => {
        if (e.target !== m) return;
        if (m.id === 'modal-dialog') $('#dlg-cancel').click(); else closeModal(m.id);
    }));

    const onScoreChange = (e) => {
        const sel = e.target.closest('select[data-match]');
        if (sel) setScore(sel.dataset.match, { [sel.dataset.key]: parseInt(sel.value, 10) || 0 });
    };
    $('#schedule').addEventListener('change', onScoreChange);
    $('#upnext').addEventListener('change', onScoreChange);
    // Double-click a match row for the larger score editor.
    $('#schedule').addEventListener('dblclick', (e) => {
        const row = e.target.closest('.m-row[data-row]');
        if (!row || e.target.closest('select') || !T) return;
        const m = T.findMatch(row.dataset.row);
        if (m && !T.isLocked(m.p1, m.p2)) openMatchEditor(m.id);
    });
    $('#search-input').addEventListener('input', renderSchedule);
    $('#round-filter').addEventListener('change', renderSchedule);
    $('#hide-done').addEventListener('change', renderSchedule);
    $('#tabs').addEventListener('click', (e) => { const b = e.target.closest('[data-tab]'); if (b) switchTab(b.dataset.tab); });
    $('#standings-mode').addEventListener('click', (e) => {
        const b = e.target.closest('[data-mode]');
        if (b) { standingsMode = b.dataset.mode; renderStandingsTab(); }
    });
    $('#history-search').addEventListener('input', renderHistory);
    $('#history-sort').addEventListener('change', renderHistory);
    $('#history-filter').addEventListener('click', (e) => {
        const b = e.target.closest('[data-filter]');
        if (b) { historyFilter = b.dataset.filter; setSegmented($('#history-filter'), 'filter', historyFilter); renderHistory(); }
    });

    $('#setup-format').addEventListener('click', (e) => {
        const c = e.target.closest('[data-format]');
        if (!c) return;
        setup.format = c.dataset.format;
        renderDetailsStep();
    });
    $('#setup-length').addEventListener('click', (e) => {
        const b = e.target.closest('[data-first-to]');
        if (!b) return;
        setup.firstTo = Number(b.dataset.firstTo);
        renderDetailsStep();
    });
    $('#setup-third').addEventListener('change', (e) => { setup.thirdPlace = e.target.checked; });
    $('#setup-rounds').addEventListener('change', (e) => { setup.swissRounds = Number(e.target.value); });
    $('#setup-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); setupNext(); } });
    $('#checkin-list').addEventListener('change', (e) => {
        const cb = e.target.closest('input[data-name]');
        if (!cb) return;
        setup.checked[cb.dataset.name] = cb.checked;
        cb.closest('.checkin').classList.toggle('off', !cb.checked);
        updateCheckinCount();
    });

    $('#page-scroll').addEventListener('scroll', (e) => { $('.main').classList.toggle('scrolled', e.target.scrollTop > 48); }, { passive: true });
    window.addEventListener('resize', () => requestAnimationFrame(refreshAllSegmented));

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            if ($$('.pop-menu.on').length) { closePopMenus(); return; }
            if (modalStack.length) {
                const top = modalStack[modalStack.length - 1];
                if (top === 'modal-dialog') $('#dlg-cancel').click(); else closeModal(top);
                return;
            }
            if (document.activeElement?.id === 'search-input' && document.activeElement.value) {
                document.activeElement.value = '';
                renderSchedule();
            }
        }
        if (!platform.isTauri && (e.metaKey || e.ctrlKey)) {
            const k = e.key.toLowerCase();
            if (k === 'z' && !isTextField(document.activeElement)) { e.preventDefault(); (e.shiftKey ? redo : undo)(); }
            else if (k === 'p') { e.preventDefault(); printBracket(); }
            else if (k === 'f' && currentView === 'active') { e.preventDefault(); handleMenu('find'); }
        }
    });

    darkMQ.addEventListener('change', applyTheme);
    platform.onMenu(handleMenu);
    platform.onFileDrop({
        enter: () => $('#drop-overlay').classList.add('on'),
        leave: () => $('#drop-overlay').classList.remove('on'),
        drop: (files, errors) => { if (files.length || errors.length) importFiles(files, errors); },
    });
}

// ============================================================================
// Boot
// ============================================================================

// Surface unexpected errors instead of failing silently.
window.addEventListener('error', (e) => { console.error(e.error || e.message); toast(`Something went wrong: ${e.message}`, 'err'); });
window.addEventListener('unhandledrejection', (e) => { console.error(e.reason); toast(`Something went wrong: ${e.reason?.message || e.reason}`, 'err'); });

async function init() {
    document.documentElement.classList.toggle('platform-mac', platform.isMac && platform.isTauri);
    document.documentElement.classList.toggle('platform-win', !platform.isMac);
    hydrateIcons();
    $$('[data-shortcut]').forEach((k) => { k.textContent = platform.modKey + k.dataset.shortcut; });

    let firstRun = false;
    try {
        const raw = await platform.loadState();
        if (raw) {
            const parsed = JSON.parse(raw);
            state = {
                version: 2,
                activeId: parsed.activeId || null,
                settings: normalizeSettings(parsed.settings),
                history: (parsed.history || []).map(normalizeRecord),
                legacyChecked: !!parsed.legacyChecked,
            };
        } else firstRun = true;
    } catch (e) {
        console.error(e);
        toast(`Couldn’t load saved data: ${e?.message || e}`, 'err');
    }
    if (state.activeId && !activeRecord()) state.activeId = null;

    applyTheme();
    initDialog();
    initEvents();
    initPlayerEntry();
    initSeedDrag();
    initSettings();

    if (activeRecord()) openRecord(state.activeId);
    else { go('home'); syncLive(); }

    if (platform.isTauri && (firstRun || !state.legacyChecked)) importLegacy(true);
}

init();
