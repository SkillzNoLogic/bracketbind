// Spectator site served by the desktop app on the local network. Read-only:
// it long-polls /api/state and renders with the same engine and views as the app.
import { Tournament, formatLabel } from './engine.js';
import { scheduleHtml, upNextHtml, standingsHtml, mountBracket, metaChips, bestOfLabel } from './views.js';
import { icon, hydrateIcons } from './icons.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

let version = null;
let data = null;
let T = null;
let tab = 'matches';
let built = false;

const mq = window.matchMedia('(prefers-color-scheme: dark)');
const applyTheme = () => { document.documentElement.dataset.theme = mq.matches ? 'dark' : 'light'; };
applyTheme();
mq.addEventListener('change', applyTheme);
hydrateIcons();

function setConnected(ok) {
    const pill = $('#v-live');
    pill.classList.toggle('lost', !ok);
    $('.live-dot', pill).classList.toggle('on', ok);
    $('#v-live-text').textContent = ok ? 'Live' : 'Reconnecting…';
}

function ago(iso) {
    if (!iso) return '';
    const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 15) return 'just now';
    if (s < 60) return `${Math.round(s)}s ago`;
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function setSegmented(el, value) {
    const buttons = $$('button[data-tab]', el);
    buttons.forEach((b) => b.classList.toggle('on', b.dataset.tab === value));
    const on = buttons.find((b) => b.dataset.tab === value);
    const thumb = $('.seg-thumb', el);
    if (!on || !thumb) return;
    const place = () => { if (on.offsetWidth) { thumb.style.left = `${on.offsetLeft}px`; thumb.style.width = `${on.offsetWidth}px`; } };
    place();
    requestAnimationFrame(place);
}

function buildSkeleton() {
    $('#v-main').innerHTML = `
        <div class="chips" id="v-chips"></div>
        <div class="progress" style="margin-top:14px"><div class="fill" id="v-progress"></div></div>
        <div class="tabs-row">
            <div class="segmented glass" id="v-tabs">
                <span class="seg-thumb"></span>
                <button data-tab="matches">${icon('list')}Matches</button>
                <button data-tab="bracket">${icon('bracket')}<span id="v-bracket-label">Bracket</span></button>
                <button data-tab="standings">${icon('chart')}Standings</button>
            </div>
        </div>
        <section class="tab-panel" data-tab="matches">
            <div class="v-grid">
                <div>
                    <div id="v-next-wrap"><div class="sub-title">${icon('play')}Up next</div><div id="v-next"></div></div>
                    <div id="v-schedule"></div>
                </div>
                <div class="side-card glass"><h3>Standings</h3><div id="v-side"></div></div>
            </div>
        </section>
        <section class="tab-panel" data-tab="bracket"><div class="bracket-panel glass" id="v-bracket"></div></section>
        <section class="tab-panel" data-tab="standings"><div class="standings-card glass" id="v-standings"></div></section>`;
    $('#v-tabs').addEventListener('click', (e) => {
        const b = e.target.closest('[data-tab]');
        if (!b) return;
        tab = b.dataset.tab;
        renderPanels();
    });
    built = true;
}

function renderWaiting() {
    built = false;
    $('#v-title').textContent = 'Bracket Maker';
    $('#v-sub').textContent = 'Live tournament';
    document.title = 'Live Tournament';
    $('#v-main').innerHTML = `
        <div class="v-waiting glass-strong">
            <div class="brand-mark">${icon('trophy')}</div>
            <h2>Waiting for a tournament</h2>
            <p>This page updates by itself as soon as the organiser opens one.</p>
        </div>`;
}

function renderPanels() {
    setSegmented($('#v-tabs'), tab);
    $$('.tab-panel').forEach((p) => p.classList.toggle('on', p.dataset.tab === tab));
    if (tab === 'matches') {
        const next = T.isComplete() ? '' : upNextHtml(T, { limit: 4 });
        $('#v-next-wrap').classList.toggle('hidden', !next);
        $('#v-next').innerHTML = next;
        $('#v-schedule').innerHTML = scheduleHtml(T, {});
        $('#v-side').innerHTML = standingsHtml(T, { compact: true, limit: 10 });
    } else if (tab === 'bracket') {
        mountBracket($('#v-bracket'), T, { zoomKey: data.name });
    } else {
        $('#v-standings').innerHTML = standingsHtml(T, {});
    }
}

function render() {
    if (!data) { renderWaiting(); return; }
    if (!built) buildSkeleton();
    T = new Tournament(data);
    document.title = `${data.name} · Live`;
    $('#v-title').textContent = data.name;
    $('#v-sub').textContent = `${formatLabel(data.format, true)} · ${bestOfLabel(T)} · updated ${ago(data.updatedAt)}`;
    $('#v-chips').innerHTML = metaChips(T, data);
    const p = T.progress();
    $('#v-progress').style.width = `${p.total ? (p.done / p.total) * 100 : 0}%`;
    $('#v-bracket-label').textContent = { rr: 'Grid', swiss: 'Rounds', se: 'Bracket', de: 'Bracket' }[data.format];
    renderPanels();
}

async function poll() {
    try {
        const url = version === null ? '/api/state' : `/api/state?since=${version}`;
        const res = await fetch(url, { cache: 'no-store' });
        if (!res.ok) throw new Error(String(res.status));
        const json = await res.json();
        setConnected(true);
        if (json.version !== version) {
            version = json.version;
            data = json.data;
            render();
        }
        setTimeout(poll, 50);
    } catch {
        setConnected(false);
        setTimeout(poll, 3000);
    }
}

// Keep "updated … ago" fresh.
setInterval(() => {
    if (data && T) $('#v-sub').textContent = `${formatLabel(data.format, true)} · ${bestOfLabel(T)} · updated ${ago(data.updatedAt)}`;
}, 15000);
window.addEventListener('resize', () => { if (built) setSegmented($('#v-tabs'), tab); });

poll();
