// Thin bridge over the Tauri runtime. Every function has a browser fallback so the
// UI can also be opened directly in a browser for quick testing.

const T = window.__TAURI__;
export const isTauri = !!(T && T.core);
export const isMac = /Mac|iPhone|iPad/i.test(navigator.userAgentData?.platform || navigator.platform || navigator.userAgent);
export const modKey = isMac ? '⌘' : 'Ctrl+';

const LS_KEY = 'bracket_maker_state_v2';

function localDay() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export async function loadState() {
    if (isTauri) return T.core.invoke('load_state');
    try { return localStorage.getItem(LS_KEY); } catch { return null; }
}

export async function saveState(json) {
    if (isTauri) return T.core.invoke('save_state', { json, day: localDay() });
    localStorage.setItem(LS_KEY, json);
}

/**
 * Save a file via the native save dialog. Resolves to the saved path, or null if cancelled.
 * @param {string} defaultName
 * @param {string|Uint8Array} data
 */
export async function saveFile(defaultName, data, filterName, extensions) {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    if (isTauri) {
        return T.core.invoke('save_file', { defaultName, contents: Array.from(bytes), filterName, extensions });
    }
    const url = URL.createObjectURL(new Blob([bytes]));
    const a = document.createElement('a');
    a.href = url;
    a.download = defaultName;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    return defaultName;
}

const toPicked = (f) => ({ name: f.name, bytes: new Uint8Array(f.bytes) });

/** Native open dialog for backup files. Resolves to [{name, bytes}]. */
export async function pickImportFiles() {
    if (isTauri) return (await T.core.invoke('open_import_files')).map(toPicked);
    return new Promise((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.multiple = true;
        input.accept = '.txt,.zip,.json,.thub';
        input.onchange = async () => resolve(await Promise.all([...input.files].map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) }))));
        input.click();
    });
}

export async function findLegacyData() {
    if (!isTauri) return [];
    return T.core.invoke('find_legacy_data');
}

export async function revealDataFolder() {
    if (isTauri) return T.core.invoke('reveal_data_folder');
    throw new Error('Data folder is only available in the desktop app.');
}

export function onMenu(handler) {
    if (isTauri) T.event.listen('menu', (e) => handler(e.payload));
}

export function setWindowTitle(title) {
    if (isTauri) T.window.getCurrentWindow().setTitle(title).catch(() => {});
    else document.title = title;
}

/**
 * File drag & drop. In Tauri the OS-level drop gives us paths, which we read through
 * the backend; in a browser we fall back to HTML5 drop events.
 */
export function onFileDrop({ enter, leave, drop }) {
    if (isTauri) {
        T.webview.getCurrentWebview().onDragDropEvent(async (e) => {
            const p = e.payload;
            if (p.type === 'enter' || p.type === 'over') enter();
            else if (p.type === 'leave') leave();
            else if (p.type === 'drop') {
                leave();
                const files = [];
                const errors = [];
                for (const path of p.paths || []) {
                    try { files.push(toPicked(await T.core.invoke('read_dropped_file', { path }))); }
                    catch (err) { errors.push(String(err)); }
                }
                drop(files, errors);
            }
        });
        return;
    }
    const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
    window.addEventListener('dragover', (e) => { if (hasFiles(e)) { e.preventDefault(); enter(); } });
    window.addEventListener('dragleave', (e) => { if (!e.relatedTarget) leave(); });
    window.addEventListener('drop', async (e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        leave();
        const files = await Promise.all([...e.dataTransfer.files].map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) })));
        drop(files, []);
    });
}

// ---- Live website ------------------------------------------------------------------

export async function shareStart(port) {
    if (!isTauri) return { running: false, port: 0, urls: [], qr_svg: null, unsupported: true };
    return T.core.invoke('share_start', { port });
}

export async function shareStop() {
    if (isTauri) await T.core.invoke('share_stop');
}

export async function shareStatus() {
    if (!isTauri) return { running: false, port: 0, urls: [], qr_svg: null, unsupported: true };
    return T.core.invoke('share_status');
}

export async function shareUpdate(payload) {
    if (isTauri) await T.core.invoke('share_update', { payload });
}

export async function openExternal(url) {
    if (isTauri) return T.core.invoke('open_external', { url });
    window.open(url, '_blank', 'noopener');
}
