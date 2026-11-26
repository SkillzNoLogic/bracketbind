//! Live spectator website on the local network.
//!
//! While a tournament is open the app pushes its state here, and anyone on the same
//! network can watch it at `http://<this computer's IP>:<port>`. The site is read-only
//! and is built from the same engine/rendering modules as the app (embedded at
//! compile time). Updates arrive via long-polling on `/api/state?since=<version>`.

use serde::Serialize;
use std::net::{IpAddr, UdpSocket};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::Duration;
use tiny_http::{Header, Method, Request, Response, Server};

const VIEWER_HTML: &str = include_str!("../../src/viewer.html");
const STYLES: &str = include_str!("../../src/styles.css");
const ENGINE_JS: &str = include_str!("../../src/js/engine.js");
const VIEWS_JS: &str = include_str!("../../src/js/views.js");
const ICONS_JS: &str = include_str!("../../src/js/icons.js");
const VIEWER_JS: &str = include_str!("../../src/js/viewer.js");

const LONG_POLL: Duration = Duration::from_secs(25);
const PORT_ATTEMPTS: u16 = 20;

struct Feed {
    version: u64,
    payload: String,
}

struct Running {
    server: Arc<Server>,
    requested_port: u16,
    port: u16,
}

pub struct ShareState {
    feed: Arc<(Mutex<Feed>, Condvar)>,
    running: Mutex<Option<Running>>,
}

#[derive(Serialize)]
pub struct ShareInfo {
    running: bool,
    port: u16,
    urls: Vec<String>,
    qr_svg: Option<String>,
}

impl ShareState {
    pub fn new() -> Self {
        Self {
            feed: Arc::new((Mutex::new(Feed { version: 1, payload: "null".into() }), Condvar::new())),
            running: Mutex::new(None),
        }
    }

    pub fn start(&self, preferred: u16) -> Result<ShareInfo, String> {
        let mut guard = self.running.lock().map_err(|e| e.to_string())?;
        if let Some(r) = guard.as_ref() {
            if r.requested_port == preferred {
                return Ok(info(Some(r.port)));
            }
            r.server.unblock();
            *guard = None;
        }

        let mut last_err = String::new();
        for port in preferred..preferred.saturating_add(PORT_ATTEMPTS) {
            match Server::http(("0.0.0.0", port)) {
                Ok(server) => {
                    let server = Arc::new(server);
                    let srv = server.clone();
                    let feed = self.feed.clone();
                    thread::Builder::new()
                        .name("live-share".into())
                        .spawn(move || {
                            for req in srv.incoming_requests() {
                                let feed = feed.clone();
                                let _ = thread::Builder::new().spawn(move || handle(req, &feed));
                            }
                        })
                        .map_err(|e| e.to_string())?;
                    *guard = Some(Running { server, requested_port: preferred, port });
                    return Ok(info(Some(port)));
                }
                Err(e) => last_err = e.to_string(),
            }
        }
        Err(format!("Couldn’t open a port near {preferred}: {last_err}"))
    }

    pub fn stop(&self) {
        if let Ok(mut guard) = self.running.lock() {
            if let Some(r) = guard.take() {
                r.server.unblock();
            }
        }
    }

    pub fn status(&self) -> ShareInfo {
        let port = self.running.lock().ok().and_then(|g| g.as_ref().map(|r| r.port));
        info(port)
    }

    pub fn update(&self, payload: String) {
        let (lock, cv) = &*self.feed;
        if let Ok(mut f) = lock.lock() {
            if f.payload != payload {
                f.version += 1;
                f.payload = payload;
                cv.notify_all();
            }
        }
    }
}

fn info(port: Option<u16>) -> ShareInfo {
    let Some(port) = port else {
        return ShareInfo { running: false, port: 0, urls: vec![], qr_svg: None };
    };
    let urls: Vec<String> = lan_ips().into_iter().map(|ip| format!("http://{ip}:{port}")).collect();
    let qr_svg = urls.first().and_then(|u| qr(u));
    ShareInfo { running: true, port, urls, qr_svg }
}

/// The address(es) other devices should use. Asking the OS which interface would
/// route to a public / private address gives the LAN IP without sending packets.
fn lan_ips() -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for probe in ["8.8.8.8:80", "192.168.1.1:9", "10.0.0.1:9", "172.16.0.1:9"] {
        if let Ok(sock) = UdpSocket::bind("0.0.0.0:0") {
            if sock.connect(probe).is_ok() {
                if let Ok(addr) = sock.local_addr() {
                    let ip = addr.ip();
                    if let IpAddr::V4(v4) = ip {
                        if !v4.is_loopback() && !v4.is_unspecified() && !v4.is_link_local() {
                            let s = v4.to_string();
                            if !out.contains(&s) {
                                out.push(s);
                            }
                        }
                    }
                }
            }
        }
    }
    if out.is_empty() {
        out.push("127.0.0.1".into());
    }
    out
}

fn qr(text: &str) -> Option<String> {
    use qrcode::render::svg;
    let code = qrcode::QrCode::new(text.as_bytes()).ok()?;
    Some(
        code.render::<svg::Color>()
            .min_dimensions(220, 220)
            .quiet_zone(true)
            .dark_color(svg::Color("#000000"))
            .light_color(svg::Color("#ffffff"))
            .build(),
    )
}

fn header(name: &str, value: &str) -> Header {
    Header::from_bytes(name.as_bytes(), value.as_bytes()).expect("valid header")
}

fn respond(req: Request, body: &str, content_type: &str, status: u16) {
    let resp = Response::from_string(body)
        .with_status_code(status)
        .with_header(header("Content-Type", content_type))
        .with_header(header("Cache-Control", "no-store"))
        .with_header(header("X-Content-Type-Options", "nosniff"))
        .with_header(header("Referrer-Policy", "no-referrer"))
        .with_header(header(
            "Content-Security-Policy",
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'",
        ));
    let _ = req.respond(resp);
}

fn handle(req: Request, feed: &Arc<(Mutex<Feed>, Condvar)>) {
    if !matches!(req.method(), Method::Get | Method::Head) {
        return respond(req, "Method not allowed", "text/plain; charset=utf-8", 405);
    }
    let url = req.url().to_string();
    let (path, query) = url.split_once('?').unwrap_or((url.as_str(), ""));
    const JS: &str = "text/javascript; charset=utf-8";
    match path {
        "/" | "/index.html" => respond(req, VIEWER_HTML, "text/html; charset=utf-8", 200),
        "/styles.css" => respond(req, STYLES, "text/css; charset=utf-8", 200),
        "/js/engine.js" => respond(req, ENGINE_JS, JS, 200),
        "/js/views.js" => respond(req, VIEWS_JS, JS, 200),
        "/js/icons.js" => respond(req, ICONS_JS, JS, 200),
        "/js/viewer.js" => respond(req, VIEWER_JS, JS, 200),
        "/api/state" => {
            let since: Option<u64> = query
                .split('&')
                .find_map(|kv| kv.strip_prefix("since="))
                .and_then(|v| v.parse().ok());
            let (lock, cv) = &**feed;
            let body = {
                let Ok(mut f) = lock.lock() else {
                    return respond(req, "{}", "application/json", 500);
                };
                if let Some(since) = since {
                    // Wait for a change, but answer straight away if the client is out of sync.
                    if f.version == since {
                        f = match cv.wait_timeout_while(f, LONG_POLL, |f| f.version == since) {
                            Ok((g, _)) => g,
                            Err(_) => return respond(req, "{}", "application/json", 500),
                        };
                    }
                }
                format!("{{\"version\":{},\"data\":{}}}", f.version, f.payload)
            };
            respond(req, &body, "application/json; charset=utf-8", 200)
        }
        "/favicon.ico" => respond(req, "", "image/x-icon", 204),
        _ => respond(req, "Not found", "text/plain; charset=utf-8", 404),
    }
}
