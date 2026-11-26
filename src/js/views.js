// Shared rendering: used by the desktop app (editable) and the spectator site (read-only).
import { cleanPlayerName, isTBD, isBye, isReal, formatLabel } from './engine.js';
import { icon } from './icons.js';

export function esc(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function splitSeed(label) {
    const m = /^\(#(\d+)\)\s(.*)$/.exec(label || '');
    return m ? { seed: m[1], name: m[2] } : { seed: null, name: label };
}

/** "TBD (Winner W0_M1)" → "Winner of W·R1 M2", "TBD (A vs B)" → "A / B". */
export function prettyTBD(label) {
    const inner = String(label).replace(/^TBD\s*\(?/, '').replace(/\)$/, '');
    const m = /^(Winner|Loser) ([A-Z]+?)(\d+)_M(\d+)$/i.exec(inner);
    if (m) {
        const bracket = { R: '', W: 'W ', L: 'L ' }[m[2].toUpperCase()] ?? `${m[2]} `;
        return `${m[1]} of ${bracket}R${Number(m[3]) + 1} · M${Number(m[4]) + 1}`;
    }
    if (/^(Winner|Loser) 3RD$/i.test(inner)) return 'TBD';
    const vs = /^(.*) vs (.*)$/.exec(inner);
    if (vs) return `${vs[1]} / ${vs[2]}`;
    if (/^\d(st|nd|rd|th) Place$/i.test(inner)) return 'TBD';
    return 'TBD';
}

export const bestOfLabel = (T) => `Best of ${T.bestOf}`;

/** Rank badge: gold/silver/bronze medallions for the podium, plain numbers otherwise. */
export function rankBadge(r) {
    if (r.isDQ) return '<span class="rank-badge dq">DQ</span>';
    if (r.alive) return '<span class="rank-badge alive" title="Still in the bracket">•</span>';
    const tie = String(r.placeLabel || '').startsWith('T');
    const medal = r.place <= 3 ? ` m${r.place}` : '';
    return `<span class="rank-badge${medal}" title="${esc(r.placeLabel)}">${tie ? '<i class="tie">T</i>' : ''}${r.place}</span>`;
}

export function formDots(form, max = 5) {
    const recent = form.slice(-max);
    if (!recent.length) return '<span class="tertiary">—</span>';
    return `<span class="form-dots">${recent.map((f) => `<i class="f-${f}" title="${f === 'W' ? 'Win' : 'Loss'}"></i>`).join('')}</span>`;
}

// ---------------------------------------------------------------------------------
// Match rows
// ---------------------------------------------------------------------------------

function scorePill(T, m, key, value, other, isWin, editable) {
    if (!editable) return `<span class="pill${isWin ? ' win' : ''}">${value}</span>`;
    const max = other === T.target ? T.target - 1 : T.target;
    const top = Math.max(max, value);
    let opts = '';
    for (let v = 0; v <= top; v++) opts += `<option value="${v}"${v === value ? ' selected' : ''}>${v}</option>`;
    return `<select class="pill${isWin ? ' win' : ''}" data-match="${esc(m.id)}" data-key="${key}" aria-label="Score">${opts}</select>`;
}

function sideHtml(T, label, side, outcome) {
    if (isBye(label)) return `<div class="m-side ${side} tbd"><span class="m-name">Bye</span></div>`;
    if (isTBD(label)) return `<div class="m-side ${side} tbd"><span class="m-name" title="${esc(label)}">${esc(prettyTBD(label))}</span></div>`;
    const { seed, name } = splitSeed(label);
    const dq = T.isDQ(name);
    const seedNo = seed || T.seedOf[name];
    const seedHtml = seedNo ? `<span class="seed-chip">${seedNo}</span>` : '';
    const check = outcome === 'win' ? icon('check', 'win-check') : '';
    const dqHtml = dq ? '<span class="tag red">DQ</span>' : '';
    const nm = `<span class="m-name" data-action="player" data-name="${esc(name)}" data-player="${esc(name)}" title="${esc(name)}">${esc(name)}</span>`;
    const cls = `m-side ${side} ${outcome || ''} ${dq ? 'dq' : ''}`;
    return side === 'left'
        ? `<div class="${cls}">${dqHtml}${check}${nm}${seedHtml}</div>`
        : `<div class="${cls}">${seedHtml}${nm}${check}${dqHtml}</div>`;
}

export function matchRowHtml(T, m, { editable = false } = {}) {
    if (m.type === 'bye') return `<div class="m-row note">${icon('moon')}<span><b>${esc(m.active)}</b> has a bye this round</span></div>`;
    if (isBye(m.p1) || isBye(m.p2)) {
        const adv = isBye(m.p1) ? m.p2 : m.p1;
        if (isBye(adv)) return '';
        return `<div class="m-row note">${icon('arrow')}<span><b>${esc(isTBD(adv) ? prettyTBD(adv) : cleanPlayerName(adv))}</b> advances with a bye</span></div>`;
    }
    const s = T.score(m.id, m.p1, m.p2);
    const locked = T.isLocked(m.p1, m.p2);
    const pending = isTBD(m.p1) || isTBD(m.p2);
    const w1 = !pending && s.p1 === T.target;
    const w2 = !pending && s.p2 === T.target;
    const o1 = w1 ? 'win' : w2 ? 'lose' : '';
    const o2 = w2 ? 'win' : w1 ? 'lose' : '';
    let scores;
    if (pending) scores = '<span class="pill ghost">–</span><span class="colon">:</span><span class="pill ghost">–</span>';
    else {
        const ed = editable && !locked;
        scores = `${scorePill(T, m, 'p1', s.p1, s.p2, w1, ed)}<span class="colon">:</span>${scorePill(T, m, 'p2', s.p2, s.p1, w2, ed)}`;
    }
    const state = w1 || w2 ? 'done' : pending ? 'pending' : 'ready';
    return `<div class="m-row ${state}" data-row="${esc(m.id)}">${sideHtml(T, m.p1, 'left', o1)}<div class="m-score">${scores}</div>${sideHtml(T, m.p2, 'right', o2)}</div>`;
}

/**
 * The full schedule grouped by round.
 * @param {{editable?: boolean, query?: string, round?: string, hideDone?: boolean, repair?: object|null}} o
 */
export function scheduleHtml(T, o = {}) {
    const q = (o.query || '').trim().toLowerCase();
    const rf = o.round ?? 'all';
    const hit = (m) => {
        if (!q) return true;
        if (m.type === 'bye') return m.active.toLowerCase().includes(q);
        return cleanPlayerName(m.p1).toLowerCase().includes(q) || cleanPlayerName(m.p2).toLowerCase().includes(q);
    };
    let html = '';
    T.sections().forEach((sec, i) => {
        if (rf !== 'all' && String(i) !== String(rf)) return;
        let rows = sec.matches.filter(hit);
        if (o.hideDone) rows = rows.filter((m) => m.type !== 'bye' && !T.isMatchDone(m));
        if (!rows.length && (q || o.hideDone)) return;
        const real = sec.matches.filter((m) => m.type !== 'bye' && !isBye(m.p1) && !isBye(m.p2));
        const done = real.filter((m) => T.isMatchDone(m)).length;
        const complete = real.length && done === real.length;
        const repair = o.repair && o.repair.index === sec.index && o.editable
            ? `<button class="btn small plain" data-action="repair-round">${icon('shuffle')} Re-pair</button>` : '';
        html += `<section class="group" data-kind="${sec.kind}">
            <header class="group-head">
                <span class="kind-dot"></span><h3>${esc(sec.title)}</h3>
                ${repair}
                <span class="count ${complete ? 'complete' : ''}">${complete ? icon('check') : ''}${done}/${real.length}</span>
            </header>
            <div class="group-body">${rows.map((m) => matchRowHtml(T, m, o)).join('') || '<div class="m-row note">No matches</div>'}</div>
        </section>`;
    });
    if (T.format === 'swiss' && rf === 'all' && !q && !o.hideDone) {
        const sw = T.swiss();
        if (sw.rounds.length < sw.totalRounds) {
            html += `<section class="group locked"><header class="group-head"><span class="kind-dot"></span><h3>Swiss Round ${sw.rounds.length + 1}</h3><span class="count">${sw.totalRounds - sw.rounds.length} to go</span></header>
                <div class="group-body"><div class="m-row note">${icon('lock')}<span>Pairings appear when every match in Round ${sw.rounds.length} has a result.</span></div></div></section>`;
        }
    }
    return html || `<div class="empty">${icon('search')}<p>No matches match this filter.</p></div>`;
}

export function upNextHtml(T, { editable = false, limit = 6 } = {}) {
    const list = T.upNext(limit);
    if (!list.length) return '';
    return `<div class="next-strip">${list.map((m) => `
        <div class="next-card glass">
            <div class="next-meta"><span>${esc(m.round)}</span><span class="tertiary">${bestOfLabel(T)}</span></div>
            ${matchRowHtml(T, m, { editable })}
        </div>`).join('')}</div>`;
}

// ---------------------------------------------------------------------------------
// Standings
// ---------------------------------------------------------------------------------

export function standingsHtml(T, { mode = 'standings', limit = 0, compact = false } = {}) {
    let rows;
    if (mode === 'points') {
        rows = T.pointsTable().map((r, i) => ({ ...r, place: i + 1, placeLabel: String(i + 1) }));
    } else {
        rows = T.finalRankings();
    }
    if (limit) rows = rows.slice(0, limit);
    const swiss = T.format === 'swiss';
    const diff = (d) => `<span class="${d > 0 ? 'pos' : d < 0 ? 'neg' : 'tertiary'}">${d > 0 ? '+' : ''}${d}</span>`;
    const head = compact
        ? '<tr><th class="c-rank"></th><th>Player</th><th class="num">W–L</th><th class="num">Diff</th></tr>'
        : `<tr><th class="c-rank"></th><th>Player</th><th class="num">W</th><th class="num">L</th><th class="num">Diff</th><th class="num">Pts</th>${swiss ? '<th class="num" title="Buchholz: sum of opponents’ wins">Bh</th>' : ''}<th class="c-form">Form</th></tr>`;
    const body = rows.map((r) => {
        const name = `<button class="link" data-action="player" data-name="${esc(r.name)}" data-player="${esc(r.name)}">${esc(r.name)}</button>${r.isDQ ? ' <span class="tag red">DQ</span>' : ''}`;
        return compact
            ? `<tr class="${r.isDQ ? 'is-dq' : ''}"><td class="c-rank">${rankBadge(r)}</td><td class="c-name">${name}</td><td class="num"><b>${r.wins}–${r.losses}</b></td><td class="num">${diff(r.diff)}</td></tr>`
            : `<tr class="${r.isDQ ? 'is-dq' : ''}"><td class="c-rank">${rankBadge(r)}</td><td class="c-name">${name}<span class="seed-chip subtle">${r.seed}</span></td>
                <td class="num"><b>${r.wins}</b></td><td class="num">${r.losses}</td><td class="num">${diff(r.diff)}</td><td class="num">${r.points}</td>
                ${swiss ? `<td class="num">${r.buchholz}</td>` : ''}<td class="c-form">${formDots(r.form)}</td></tr>`;
    }).join('');
    return `<table class="standings${compact ? ' compact' : ''}"><thead>${head}</thead><tbody>${body}</tbody></table>`;
}

// ---------------------------------------------------------------------------------
// Bracket visualiser
// ---------------------------------------------------------------------------------

const CW = 228;      // card width
const CH = 70;       // card height
const GX = 72;       // column gap
const GY = 16;       // vertical gap
const HEAD = 52;     // column header band
const PAD = 20;

function bkRow(T, label, score, outcome, pending) {
    if (isBye(label)) return '<div class="bk-row tbd"><span class="bk-seed"></span><span class="bk-name">Bye</span><span class="bk-score"></span></div>';
    if (isTBD(label)) return `<div class="bk-row tbd"><span class="bk-seed"></span><span class="bk-name" title="${esc(label)}">${esc(prettyTBD(label))}</span><span class="bk-score"></span></div>`;
    const { seed, name } = splitSeed(label);
    const dq = T.isDQ(name);
    return `<div class="bk-row ${outcome || ''} ${dq ? 'dq' : ''}" data-player="${esc(name)}">
        <span class="bk-seed">${esc(seed || T.seedOf[name] || '')}</span>
        <span class="bk-name" title="${esc(name)}">${esc(name)}</span>
        <span class="bk-score">${pending ? '' : score}</span></div>`;
}

function bkCard(T, m, x, y, editable) {
    const pending = isTBD(m.p1) || isTBD(m.p2) || isBye(m.p1) || isBye(m.p2);
    const s = pending ? { p1: 0, p2: 0 } : T.score(m.id, m.p1, m.p2);
    const w1 = !pending && s.p1 === T.target;
    const w2 = !pending && s.p2 === T.target;
    const ready = !pending && !w1 && !w2 && !T.isLocked(m.p1, m.p2);
    const canEdit = editable && !pending && !T.isLocked(m.p1, m.p2);
    const state = w1 || w2 ? 'done' : ready ? 'ready' : 'waiting';
    return `<div class="bk-card ${state}${canEdit ? ' editable' : ''}" style="left:${x}px;top:${y}px" ${canEdit ? `data-edit-match="${esc(m.id)}" tabindex="0" role="button"` : ''}>
        ${bkRow(T, m.p1, s.p1, w1 ? 'win' : w2 ? 'lose' : '', pending)}
        ${bkRow(T, m.p2, s.p2, w2 ? 'win' : w1 ? 'lose' : '', pending)}
    </div>`;
}

function elbow(x1, y1, x2, y2) {
    if (Math.abs(y2 - y1) < 1) return `M${x1},${y1} H${x2}`;
    const xm = (x1 + x2) / 2;
    const r = Math.min(12, Math.abs(y2 - y1) / 2);
    const d = y2 > y1 ? 1 : -1;
    return `M${x1},${y1} H${xm - r} Q${xm},${y1} ${xm},${y1 + d * r} V${y2 - d * r} Q${xm},${y2} ${xm + r},${y2} H${x2}`;
}

/** Lay out one bracket track. Matches sit at the midpoint of their feeders. */
function layoutTrack(sections, offsetY) {
    const pos = {};
    const cols = [];
    sections.forEach((sec, c) => {
        const x = PAD + c * (CW + GX);
        const items = sec.matches.map((m, i) => {
            const feeders = [m.src1, m.src2].filter((s) => s && s.take === 'w' && pos[s.id]);
            const y = feeders.length
                ? feeders.reduce((a, s) => a + pos[s.id].y, 0) / feeders.length
                : offsetY + HEAD + i * (CH + GY);
            return { m, y, feeders };
        });
        items.sort((a, b) => a.y - b.y);
        for (let k = 1; k < items.length; k++) items[k].y = Math.max(items[k].y, items[k - 1].y + CH + GY);
        items.forEach((it) => { pos[it.m.id] = { x, y: it.y }; });
        cols.push({ x, sec, items });
    });
    const bottom = Math.max(offsetY + HEAD + CH, ...Object.values(pos).map((p) => p.y + CH));
    return { pos, cols, bottom };
}

function trackHtml(T, track, offsetY, label, editable, extras = []) {
    let cards = '';
    let heads = '';
    let paths = '';
    if (label) heads += `<div class="bk-track-label" style="left:${PAD}px;top:${offsetY - 30}px">${label}</div>`;
    track.cols.forEach(({ x, sec, items }) => {
        heads += `<div class="bk-head kind-${sec.kind}" style="left:${x}px;top:${offsetY}px;width:${CW}px"><span>${esc(sec.title)}</span><small>${bestOfLabel(T)}</small></div>`;
        items.forEach(({ m, y, feeders }) => {
            cards += bkCard(T, m, x, y, editable);
            feeders.forEach((f) => {
                const from = track.pos[f.id];
                const fm = T.findMatch(f.id);
                const o = T.outcome(fm);
                const advanced = o?.winner && [cleanPlayerName(m.p1), cleanPlayerName(m.p2)].includes(o.winner);
                paths += `<path class="bk-link${advanced ? ' live' : ''}" ${advanced ? `data-winner="${esc(o.winner)}"` : ''} d="${elbow(from.x + CW, from.y + CH / 2, x, y + CH / 2)}"/>`;
            });
        });
    });
    extras.forEach((e) => { cards += e.html; paths += e.path || ''; });
    return { cards, heads, paths };
}

function championCard(x, y, name, label = 'Champion') {
    return `<div class="bk-champion ${name ? '' : 'pending'}" style="left:${x}px;top:${y}px">
        <div class="trophy">${icon('trophy')}</div>
        <div><small>${label}</small><b>${name ? esc(name) : 'To be decided'}</b></div>
    </div>`;
}

function eliminationBoard(T, editable) {
    let width = 0;
    let height = 0;
    let cards = '';
    let heads = '';
    let paths = '';

    if (T.format === 'se') {
        const secs = T.sections().filter((s) => s.kind !== 'third');
        const tr = layoutTrack(secs, PAD);
        const last = tr.cols[tr.cols.length - 1];
        const final = last.items[0];
        const champX = last.x + CW + GX;
        const champ = T.se().champion;
        const extras = [{
            html: championCard(champX, final.y + CH / 2 - 34, champ ? cleanPlayerName(champ) : null),
            path: `<path class="bk-link${champ ? ' live' : ''}" ${champ ? `data-winner="${esc(cleanPlayerName(champ))}"` : ''} d="M${last.x + CW},${final.y + CH / 2} H${champX}"/>`,
        }];
        const third = T.se().third;
        if (third) {
            const ty = final.y + CH + 64;
            extras.push({ html: `<div class="bk-sub" style="left:${last.x}px;top:${ty - 24}px">Third place</div>${bkCard(T, third, last.x, ty, editable)}` });
            height = Math.max(height, ty + CH + PAD);
        }
        const out = trackHtml(T, tr, PAD, '', editable, extras);
        cards = out.cards; heads = out.heads; paths = out.paths;
        width = champX + 220 + PAD;
        height = Math.max(height, tr.bottom + PAD);
    } else {
        const secs = T.sections();
        const upper = secs.filter((s) => s.kind !== 'losers');
        const lower = secs.filter((s) => s.kind === 'losers');
        const top = PAD + 30;
        const wt = layoutTrack(upper, top);
        const s = T.de();
        const last = wt.cols[wt.cols.length - 1];
        const lastCard = last.items[0];
        const champX = last.x + CW + GX;
        const champ = isReal(s.firstPlace) ? cleanPlayerName(s.firstPlace) : null;
        const w = trackHtml(T, wt, top, 'Winners Bracket', editable, [{
            html: championCard(champX, lastCard.y + CH / 2 - 34, champ),
            path: `<path class="bk-link${champ ? ' live' : ''}" ${champ ? `data-winner="${esc(champ)}"` : ''} d="M${last.x + CW},${lastCard.y + CH / 2} H${champX}"/>`,
        }]);
        cards += w.cards; heads += w.heads; paths += w.paths;
        width = champX + 220 + PAD;
        height = wt.bottom + PAD;
        if (lower.length) {
            const lTop = wt.bottom + 70;
            const lt = layoutTrack(lower, lTop);
            const l = trackHtml(T, lt, lTop, 'Losers Bracket', editable);
            cards += l.cards; heads += l.heads; paths += l.paths;
            width = Math.max(width, PAD * 2 + lt.cols.length * (CW + GX));
            height = lt.bottom + PAD;
        }
    }
    return `<div class="bk-board" style="width:${width}px;height:${height}px">
        <svg class="bk-links" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${paths}</svg>
        ${heads}${cards}
    </div>`;
}

function swissBoard(T, editable) {
    const sw = T.swiss();
    const cols = sw.rounds.map((r) => {
        const groups = new Map();
        r.matches.forEach((m) => {
            const rec = m.type === 'bye' ? m.rec : m.rec1;
            const key = rec ? `${rec[0]}–${rec[1]}` : '';
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(m);
        });
        const ordered = [...groups.entries()].sort((a, b) => Number(b[0].split('–')[0]) - Number(a[0].split('–')[0]));
        return `<div class="sw-col">
            <div class="bk-head static"><span>${esc(r.title)}</span><small>${bestOfLabel(T)}</small></div>
            ${ordered.map(([key, ms]) => `<div class="sw-group"><div class="sw-pool">${key ? `${key} pool` : ''}</div>
                ${ms.map((m) => (m.type === 'bye'
        ? `<div class="bk-card static bye-card"><div class="bk-row win" data-player="${esc(m.active)}"><span class="bk-seed">${T.seedOf[m.active] || ''}</span><span class="bk-name">${esc(m.active)}</span><span class="bk-score tag">Bye</span></div></div>`
        : bkCard(T, m, 0, 0, editable).replace('class="bk-card', 'class="bk-card static'))).join('')}
            </div>`).join('')}
        </div>`;
    });
    for (let r = sw.rounds.length; r < sw.totalRounds; r++) {
        cols.push(`<div class="sw-col future"><div class="bk-head static"><span>Swiss Round ${r + 1}</span><small>Upcoming</small></div>
            <div class="sw-placeholder">${icon('lock')}<span>Paired after Round ${r} finishes</span></div></div>`);
    }
    const leader = T.finalRankings()[0];
    const done = T.isComplete();
    cols.push(`<div class="sw-col narrow"><div class="bk-head static"><span>${done ? 'Winner' : 'Leader'}</span></div>
        ${leader ? `<div class="bk-champion static ${done ? '' : 'pending'}"><div class="trophy">${icon('trophy')}</div><div><small>${leader.wins}–${leader.losses}</small><b>${esc(leader.name)}</b></div></div>` : ''}</div>`);
    return `<div class="sw-board">${cols.join('')}</div>`;
}

export function crosstableHtml(T) {
    const players = [...T.players].sort((a, b) => a.seed - b.seed);
    const names = players.map((p) => p.name);
    const cell = {};
    T.matches().forEach((m) => {
        const a = cleanPlayerName(m.p1);
        const b = cleanPlayerName(m.p2);
        const s = T.score(m.id, m.p1, m.p2);
        const done = s.p1 === T.target || s.p2 === T.target;
        cell[`${a}|${b}`] = { f: s.p1, a: s.p2, done, round: m.round };
        cell[`${b}|${a}`] = { f: s.p2, a: s.p1, done, round: m.round };
    });
    const tally = T.tally();
    const rank = Object.fromEntries(T.finalRankings().map((r) => [r.name, r]));
    return `<div class="xt-wrap"><table class="xt">
        <thead><tr><th class="xt-corner"></th>${names.map((n, i) => `<th title="${esc(n)}"><span>${i + 1}</span></th>`).join('')}<th class="xt-total">W–L</th><th class="xt-total">Rank</th></tr></thead>
        <tbody>${names.map((a, i) => `<tr>
            <th class="xt-name" data-player="${esc(a)}"><span class="seed-chip">${i + 1}</span>${esc(a)}${T.isDQ(a) ? ' <span class="tag red">DQ</span>' : ''}</th>
            ${names.map((b) => {
        if (a === b) return '<td class="xt-self"></td>';
        const c = cell[`${a}|${b}`];
        if (!c || !c.done) return `<td class="xt-open" title="${esc(c?.round || '')}"></td>`;
        const won = c.f === T.target;
        return `<td class="${won ? 'xt-win' : 'xt-loss'}" title="${esc(`${a} ${c.f}–${c.a} ${b} · ${c.round}`)}">${c.f}–${c.a}</td>`;
    }).join('')}
            <td class="xt-total"><b>${tally[a].wins}–${tally[a].losses}</b></td>
            <td class="xt-total">${rankBadge(rank[a])}</td>
        </tr>`).join('')}</tbody></table></div>`;
}

/**
 * Render the bracket/rounds/crosstable visual for any format into `container`,
 * with zoom, drag-to-pan and hover highlighting of a player's path.
 * @param {{editable?: boolean, onEdit?: (matchId: string) => void, zoomKey?: string}} opts
 */
export function mountBracket(container, T, opts = {}) {
    const editable = !!opts.editable;
    let board;
    if (T.players.length < 2) {
        container.innerHTML = `<div class="empty">${icon('map')}<p>Add players to see the bracket.</p></div>`;
        return;
    }
    if (T.format === 'rr') board = crosstableHtml(T);
    else if (T.format === 'swiss') board = swissBoard(T, editable);
    else board = eliminationBoard(T, editable);

    const zoomable = T.format === 'se' || T.format === 'de';
    // Remember zoom per tournament, not per container, so switching events refits.
    const key = `${opts.zoomKey || ''}|${T.format}`;
    const sameBoard = container.dataset.zoomKey === key;
    const prevZoom = sameBoard ? Number(container.dataset.zoom) || 0 : 0;
    const oldVp = container.querySelector('.bk-viewport');
    const keepScroll = sameBoard && oldVp ? [oldVp.scrollLeft, oldVp.scrollTop] : null;
    container.dataset.zoomKey = key;
    const legend = {
        se: [['accent', 'Played'], ['ring', 'Ready to play'], ['gold', 'Champion']],
        de: [['accent', 'Winners'], ['orange', 'Losers'], ['green', 'Finals'], ['ring', 'Ready to play']],
        swiss: [['ring', 'Ready to play'], ['accent', 'Won']],
        rr: [['green', 'Win'], ['red', 'Loss'], ['fill', 'Not played']],
    }[T.format].map(([k, l]) => `<span class="lg"><i class="sw sw-${k}"></i>${l}</span>`).join('');
    container.innerHTML = `
        <div class="bk-bar">
            <div class="bk-legend">${legend}</div>
            ${zoomable ? `<div class="bk-tools capsule">
                <button class="icon-btn" data-zoom="-" title="Zoom out">${icon('minus')}</button>
                <button class="zoom-label" data-zoom="fit" title="Fit to width">100%</button>
                <button class="icon-btn" data-zoom="+" title="Zoom in">${icon('plus')}</button>
            </div>` : ''}
        </div>
        <div class="bk-viewport"><div class="bk-sizer"><div class="bk-stage">${board}</div></div></div>`;

    const viewport = container.querySelector('.bk-viewport');
    const stage = container.querySelector('.bk-stage');
    const sizer = container.querySelector('.bk-sizer');
    const boardEl = stage.firstElementChild;
    const label = container.querySelector('.zoom-label');

    const apply = (z) => {
        z = Math.max(0.35, Math.min(1.6, z));
        container.dataset.zoom = String(z);
        if (!zoomable) return;
        stage.style.transform = `scale(${z})`;
        sizer.style.width = `${boardEl.offsetWidth * z}px`;
        sizer.style.height = `${boardEl.offsetHeight * z}px`;
        if (label) label.textContent = `${Math.round(z * 100)}%`;
    };
    // Fit to width, but never so small that names become unreadable — pan for the rest.
    const fit = () => apply(Math.max(0.72, Math.min(1, (viewport.clientWidth - 8) / boardEl.offsetWidth)));
    if (zoomable) {
        if (prevZoom) apply(prevZoom);
        requestAnimationFrame(() => { if (!prevZoom) fit(); });
        container.querySelectorAll('[data-zoom]').forEach((b) => b.addEventListener('click', () => {
            const z = Number(container.dataset.zoom) || 1;
            if (b.dataset.zoom === '+') apply(z + 0.15);
            else if (b.dataset.zoom === '-') apply(z - 0.15);
            else fit();
        }));
        viewport.addEventListener('wheel', (e) => {
            if (!(e.ctrlKey || e.metaKey)) return;
            e.preventDefault();
            apply((Number(container.dataset.zoom) || 1) * (e.deltaY < 0 ? 1.08 : 0.92));
        }, { passive: false });
    }

    if (keepScroll) { viewport.scrollLeft = keepScroll[0]; viewport.scrollTop = keepScroll[1]; }

    // Drag empty space to pan.
    viewport.addEventListener('pointerdown', (e) => {
        if (e.button !== 0 || e.target.closest('.bk-card, button, select, a, th')) return;
        const sx = e.clientX, sy = e.clientY, sl = viewport.scrollLeft, st = viewport.scrollTop;
        viewport.classList.add('panning');
        const move = (ev) => { viewport.scrollLeft = sl - (ev.clientX - sx); viewport.scrollTop = st - (ev.clientY - sy); };
        const up = () => { viewport.classList.remove('panning'); window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
    });

    // Hover a player to trace their path.
    let focused = null;
    const setFocus = (name) => {
        if (name === focused) return;
        focused = name;
        container.classList.toggle('has-focus', !!name);
        container.querySelectorAll('.hl').forEach((el) => el.classList.remove('hl'));
        if (!name) return;
        const sel = CSS.escape(name);
        container.querySelectorAll(`[data-player="${sel}"], [data-winner="${sel}"]`).forEach((el) => {
            el.classList.add('hl');
            el.closest('.bk-card')?.classList.add('hl');
        });
    };
    container.addEventListener('pointerover', (e) => setFocus(e.target.closest('[data-player]')?.dataset.player || null));
    container.addEventListener('pointerleave', () => setFocus(null));

    if (editable && opts.onEdit) {
        const open = (e) => {
            const card = e.target.closest('[data-edit-match]');
            if (card) opts.onEdit(card.dataset.editMatch);
        };
        container.addEventListener('click', open);
        container.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(e); } });
    }
}

export function metaChips(T, rec) {
    const prog = T.progress();
    const complete = T.isComplete();
    const dq = T.players.filter((p) => p.isDQ).length;
    let extra = '';
    if (T.format === 'swiss') extra = `<span class="chip">${T.swissRounds} rounds</span>`;
    if (T.format === 'se' && T.thirdPlace) extra = '<span class="chip">3rd-place match</span>';
    return `<span class="chip">${formatLabel(rec.format, true)}</span>
        <span class="chip">${bestOfLabel(T)}</span>
        <span class="chip">${T.players.length} players${dq ? ` · ${dq} DQ` : ''}</span>${extra}
        <span class="chip ${complete ? 'green' : 'blue'}">${complete ? `${icon('check')} Complete` : `${prog.done} of ${prog.total} played`}</span>`;
}
