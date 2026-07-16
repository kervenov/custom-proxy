const fs = require("fs");
const express = require("express");
const axios = require("axios");
const app = express();

/* ================================
   0) Config (domains.json)
=================================== */
let CFG;
try {
    CFG = JSON.parse(fs.readFileSync(__dirname + "/domains.json", "utf8"));
} catch (e) {
    console.error("domains.json okunamadı:", e.message);
    process.exit(1);
}

const PORT = process.env.PORT || CFG.port || 8080;
const UPSTREAM_URL = process.env.UPSTREAM_URL || CFG.upstream_url || "https://ze.cyber-x.online:10086/sub/";
const STATIC_CONFIGS_PATH = process.env.STATIC_CONFIGS_PATH || CFG.static_configs_path || "/root/vpn-config.json";

/* ================================
   1) Domain → Provider ID + Backup URL
=================================== */
const DOMAIN_CONFIG = CFG.domains || {};
const DEFAULT_CONFIG = CFG.default || { providerId: "", backup: "" };

/* ================================
   1a) Türkmenistan IPv4 CIDR blokları (split tunneling)
   Bu ağlara giden trafik tünelden GEÇMEZ — yerel TM trafiği doğrudan gider.
   Kaynak: RIR delegation verisi (ipverse/rir-ip ve ipdeny.com — iki kaynak da
   Temmuz 2026'da aynı 11 bloğu veriyor). Tahsisler değişebilir; periyodik
   güncellemek gerekir.
=================================== */
const TM_CIDRS = [
    "77.83.59.0/24",
    "95.85.96.0/19",
    "103.220.0.0/22",
    "119.235.112.0/20",
    "177.93.143.0/24",
    "185.69.184.0/22",
    "185.246.72.0/22",
    "194.117.52.192/26",
    "216.250.8.0/21",
    "217.65.78.0/24",
    "217.174.224.0/20",
];

/* ================================
   1b) Happ app yönetim ayarları (ProviderID gerektirir)
   Docs: https://www.happ.su/main/dev-docs/app-management
   Her biri hem response header'ı hem "#key: value" body satırı olarak
   gönderilir (asağıdaki tek objeden üretilir, sapma olmaz).
=================================== */
const APP_SETTINGS = {
    /* --- Abonelik ayarları --- */
    "subscription-auto-update-open-enable": "1",   // Update on open: On
    "subscription-ping-onopen-enabled":     "1",   // Ping on open: On
    "subscription-autoconnect":             "0",   // Connect on open: Off
    "subscription-autoconnect-type": "lastused",   // Connect to: Last used (lastused/lowestdelay/random)
    "subscriptions-collapse":               "0",   // Collapse subscriptions: Off (0 = hep açık)
    "dont-use-filter":                      "0",   // Don't use filter: Off
    "subscription-request-timeout":         "8",   // Subscription request timeout: 8 sn (5-15)
    "subscriptions-sort-type":        "without",   // Server List: Unsorted (without/ping/alphabet)

    /* --- Gelişmiş ayarlar --- */
    "sniffing-enable":                      "1",   // Enable sniffing: On
    "dns-from-json-enable":                 "0",   // Use DNS from JSON: Off
    "server-address-resolve-enable":        "0",   // Enable Resolve Server: Off
    "app-auto-start":                       "0",   // Autostart: Off
    "tun-enable":                           "1",   // TUN: On (Desktop)
    "tun-type":                       "singbox",   // TUN provider: sing-box (singbox/tun2proxy/default)
    "tun-mode":                        "gvisor",   // TUN mode: gVisor (system/gvisor)

    /* --- Excluded routes ---
       -set varyanti mevcut listeyi ONCE TEMIZLER, sonra yazar. Her abonelik
       guncellemesinde gonderildigi icin additive "exclude-routes" kullanilsa
       liste birikirdi; -set deterministik kalir. */
    "exclude-routes-set": TM_CIDRS.join(","),      // Excluded routes: TM IP blokları
};

/* UA blacklist + BLOCK_RESPONSE REMOVED — moved into the Marzban
   panel so the gatekeeping happens in ONE place. The panel's
   subscription router now 403s the same set of clients (browsers,
   curl, wget, python-requests, etc.) before any work is done. */

/* ================================
   Static config file (unchanged)
=================================== */
function vlessJsonToUri(outbound, remarks) {
    const vnext = outbound.settings && outbound.settings.vnext && outbound.settings.vnext[0];
    if (!vnext) return null;
    const user = vnext.users && vnext.users[0];
    if (!user) return null;

    const ss = outbound.streamSettings || {};
    const params = new URLSearchParams();
    params.set("encryption", user.encryption || "none");
    if (user.flow) params.set("flow", user.flow);

    const network = ss.network || "tcp";
    params.set("type", network);

    if (network === "ws") {
        const w = ss.wsSettings || {};
        if (w.path) params.set("path", w.path);
        if (w.headers && w.headers.Host) params.set("host", w.headers.Host);
    } else if (network === "grpc") {
        const g = ss.grpcSettings || {};
        if (g.serviceName) params.set("serviceName", g.serviceName);
        if (g.multiMode) params.set("mode", "multi");
    } else if (network === "tcp") {
        const t = ss.tcpSettings || {};
        if (t.header && t.header.type) params.set("headerType", t.header.type);
    } else if (network === "xhttp" || network === "splithttp") {
        const x = ss.xhttpSettings || ss.splithttpSettings || {};
        if (x.path) params.set("path", x.path);
        if (x.host) params.set("host", x.host);
        if (x.mode) params.set("mode", x.mode);
        if (x.extra) params.set("extra", JSON.stringify(x.extra));
    } else if (network === "h2" || network === "http") {
        const h = ss.httpSettings || {};
        if (h.path) params.set("path", h.path);
        if (Array.isArray(h.host)) params.set("host", h.host.join(","));
    } else if (network === "kcp") {
        const k = ss.kcpSettings || {};
        if (k.header && k.header.type) params.set("headerType", k.header.type);
        if (k.seed) params.set("seed", k.seed);
    }

    const security = ss.security || "none";
    params.set("security", security);

    if (security === "tls") {
        const tls = ss.tlsSettings || {};
        if (tls.serverName) params.set("sni", tls.serverName);
        if (tls.fingerprint) params.set("fp", tls.fingerprint);
        if (Array.isArray(tls.alpn) && tls.alpn.length) params.set("alpn", tls.alpn.join(","));
        if (tls.allowInsecure) params.set("allowInsecure", "1");
    } else if (security === "reality") {
        const r = ss.realitySettings || {};
        if (r.serverName) params.set("sni", r.serverName);
        if (r.publicKey) params.set("pbk", r.publicKey);
        if (r.shortId) params.set("sid", r.shortId);
        if (r.spiderX) params.set("spx", r.spiderX);
        if (r.fingerprint) params.set("fp", r.fingerprint);
    }

    const label = encodeURIComponent(remarks || "Static");
    return `vless://${user.id}@${vnext.address}:${vnext.port}?${params.toString()}#${label}`;
}

function vmessJsonToUri(outbound, remarks) {
    const vnext = outbound.settings && outbound.settings.vnext && outbound.settings.vnext[0];
    if (!vnext) return null;
    const user = vnext.users && vnext.users[0];
    if (!user) return null;

    const ss = outbound.streamSettings || {};
    const network = ss.network || "tcp";
    const security = ss.security || "none";

    const obj = {
        v: "2",
        ps: remarks || "Static",
        add: vnext.address,
        port: String(vnext.port),
        id: user.id,
        aid: String(user.alterId || 0),
        scy: user.security || "auto",
        net: network,
        type: "none",
        host: "",
        path: "",
        tls: security === "tls" ? "tls" : "",
        sni: "",
        alpn: "",
        fp: ""
    };

    if (network === "ws") {
        const w = ss.wsSettings || {};
        obj.path = w.path || "";
        if (w.headers && w.headers.Host) obj.host = w.headers.Host;
    } else if (network === "tcp") {
        const t = ss.tcpSettings || {};
        if (t.header) obj.type = t.header.type || "none";
    }

    if (security === "tls") {
        const tls = ss.tlsSettings || {};
        if (tls.serverName) obj.sni = tls.serverName;
        if (Array.isArray(tls.alpn)) obj.alpn = tls.alpn.join(",");
        if (tls.fingerprint) obj.fp = tls.fingerprint;
    }

    return "vmess://" + Buffer.from(JSON.stringify(obj)).toString("base64");
}

function trojanJsonToUri(outbound, remarks) {
    const s = outbound.settings && outbound.settings.servers && outbound.settings.servers[0];
    if (!s) return null;

    const ss = outbound.streamSettings || {};
    const params = new URLSearchParams();

    const network = ss.network || "tcp";
    params.set("type", network);

    if (network === "ws") {
        const w = ss.wsSettings || {};
        if (w.path) params.set("path", w.path);
        if (w.headers && w.headers.Host) params.set("host", w.headers.Host);
    } else if (network === "grpc") {
        const g = ss.grpcSettings || {};
        if (g.serviceName) params.set("serviceName", g.serviceName);
    }

    const security = ss.security || "tls";
    params.set("security", security);

    if (security === "tls" && ss.tlsSettings) {
        const tls = ss.tlsSettings;
        if (tls.serverName) params.set("sni", tls.serverName);
        if (tls.fingerprint) params.set("fp", tls.fingerprint);
        if (Array.isArray(tls.alpn) && tls.alpn.length) params.set("alpn", tls.alpn.join(","));
    }

    const label = encodeURIComponent(remarks || "Static");
    return `hysteria2://${encodeURIComponent(s.password)}@${s.address}:${s.port}?${params.toString()}#${label}`;
}

function shadowsocksJsonToUri(outbound, remarks) {
    const s = outbound.settings && outbound.settings.servers && outbound.settings.servers[0];
    if (!s) return null;
    const auth = Buffer.from(`${s.method}:${s.password}`).toString("base64");
    const label = encodeURIComponent(remarks || "Static");
    return `ss://${auth}@${s.address}:${s.port}#${label}`;
}

function jsonConfigToUri(config) {
    if (!config || typeof config !== "object") return null;
    const outbounds = Array.isArray(config.outbounds) ? config.outbounds : [];
    const proxy = outbounds.find(o =>
        o && typeof o.protocol === "string" &&
        ["vless", "vmess", "hysteria2", "shadowsocks"].includes(o.protocol)
    );
    if (!proxy) return null;
    const remarks = config.remarks ||
                    (proxy.tag && proxy.tag !== "proxy" ? proxy.tag : null) ||
                    "Static";
    switch (proxy.protocol) {
        case "vless":        return vlessJsonToUri(proxy, remarks);
        case "vmess":        return vmessJsonToUri(proxy, remarks);
        case "hysteria2":    return trojanJsonToUri(proxy, remarks);
        case "shadowsocks":  return shadowsocksJsonToUri(proxy, remarks);
        default: return null;
    }
}

function loadStaticConfigs() {
    try {
        const raw = fs.readFileSync(STATIC_CONFIGS_PATH, "utf8").trim();
        if (!raw) return [];

        if (raw.startsWith("{") || raw.startsWith("[")) {
            try {
                const parsed = JSON.parse(raw);
                const list = Array.isArray(parsed) ? parsed : [parsed];
                return list.map(jsonConfigToUri).filter(Boolean);
            } catch (jsonErr) {
                // JSON parse fail → text moduna düş
            }
        }

        return raw
            .split(/\r?\n/)
            .map(line => line.trim())
            .filter(line => /^(ss|vless|vmess|hysteria2):\/\//.test(line));
    } catch (err) {
        return [];
    }
}

/* ================================
   2) Subscription Proxy
=================================== */
app.get("/sub/:data", async (req, res) => {

    /* UA gate REMOVED — moved into the Marzban panel
       (app/routers/subscription.py). The panel now 403s browsers /
       curl / wget / python-requests / etc. before any work happens.
       Letting the panel decide also means the operator can update
       the blacklist in ONE place without redeploying this proxy. */

    const host = (req.headers.host || "").toLowerCase().split(":")[0];
    const cfg = DOMAIN_CONFIG[host] || DEFAULT_CONFIG;
    const PROVIDER_ID = cfg.providerId;
    const BACKUP_DOMAIN = cfg.backup;
    const proxyHost = host;

    const realUrl = `${UPSTREAM_URL}${req.params.data}`;

    try {
        /* Forward HWID/device fingerprint headers + the REAL
           User-Agent. The previous version hardcoded
           ``User-Agent: "Happ/3.13.0"`` which made every entry in the
           panel's connected_devices.user_agent show "Happ/3.13.0"
           regardless of which client actually fetched (operator
           caught this 2026-06-28). Forward the incoming UA verbatim
           so the panel can distinguish Happ/3.13.0 vs v2rayN/X vs
           Clash/X vs sing-box/SFA/X — connected_devices now shows
           real per-device client identities. */
        const forwardHeaders = {
            "User-Agent": req.headers["user-agent"] || "Unknown",
            "Accept": req.headers["accept"] || "text/plain"
        };
        if (req.headers["x-hwid"])         forwardHeaders["x-hwid"]         = req.headers["x-hwid"];
        if (req.headers["x-device-model"]) forwardHeaders["x-device-model"] = req.headers["x-device-model"];
        if (req.headers["x-device-os"])    forwardHeaders["x-device-os"]    = req.headers["x-device-os"];
        if (req.headers["x-ver-os"])       forwardHeaders["x-ver-os"]       = req.headers["x-ver-os"];

        const response = await axios.get(realUrl, {
            responseType: "text",
            validateStatus: () => true,
            headers: forwardHeaders
        });

        if (response.status !== 200) {
            return res.status(response.status).send("Error: " + response.status);
        }

        let b64 = response.data.trim();
        let decoded;
        try {
            decoded = Buffer.from(b64, "base64").toString().split(/\r?\n/);
        } catch (err) {
            decoded = b64.split(/\r?\n/);
        }

        let upload = 0, download = 0, total = 0, expire = 0;
        const info = response.headers["subscription-userinfo"] ||
                     response.headers["Subscription-Userinfo"];

        if (info) {
            const match = info.match(/upload=(\d+); *download=(\d+); *total=(\d+); *expire=(\d+)/);
            if (match) {
                upload = match[1];
                download = match[2];
                total = match[3];
                expire = match[4];
            }
        }

        const configs = decoded.filter(line =>
            /^(ss|vless|vmess|hysteria2):\/\//.test(line.trim())
        );

        const staticConfigs = (configs.length > 0) ? loadStaticConfigs() : [];

        const userToken = encodeURIComponent(req.params.data);
        const fallbackUrl = `${BACKUP_DOMAIN}${userToken}`;

        res.set("new-url", `${BACKUP_DOMAIN}${userToken}`);
        res.set("new-domain", proxyHost);
        res.set("fallback-url", fallbackUrl);
        res.set("providerid", PROVIDER_ID);
        res.set("hide-settings", "1");
        res.set("subscription-always-hwid-enable", "1");
        res.set("subscription-auto-update-enable", "1");
        res.set("subscriptions-expand-now", "1");
        res.set("notification-subs-expire", "1");
        res.set("check-url-via-proxy", "https://cp.cloudflare.com/generate_204");
        res.set("ping-result", "time");
        res.set("proxy-ping-mode", "keepalive");
        res.set("ping-type", "proxy");
        for (const [k, v] of Object.entries(APP_SETTINGS)) res.set(k, v);

        const output = [
            "#profile-title: base64:4pqc77iPIEjhtIDhtJjhtJggU+G0m+G0j8qA4bSHIOKanO+4jw==",
            "#profile-update-interval: 1",
            "#support-url: https://t.me/CybeR_CollectivE",
            "#profile-web-page-url: https://ipinfo.io/what-is-my-ip",
            "#announce: base64:8J+UhCDQn9C+0LTQv9C40YHQutCwINC+0LHQvdC+0LLQu9GP0LXRgtGB0Y8g0LrQsNC20LTRi9C5INGH0LDRgSEg8J+UhArimqDvuI8g0J/RgNC4INC/0YDQvtCx0LvQtdC80LDRhSDQv9C10YDQtdC30LDQs9GA0YPQt9C40YLQtSDRg9GB0YLRgNC+0LnRgdGC0LLQviDQuCDQtNC+0LHQsNCy0YzRgtC1INGB0YHRi9C70LrRgyDQt9Cw0L3QvtCy0L4uIOKaoO+4jw==",
            `#subscription-userinfo: upload=${upload}; download=${download}; total=${total}; expire=${expire}`,
            `#new-url ${BACKUP_DOMAIN}${userToken}`,
            `#providerid ${PROVIDER_ID}`,
            `#new-domain: ${proxyHost}`,
            `#fallback-url: ${fallbackUrl}`,
            "#hide-settings: 1",
            "#subscription-always-hwid-enable: 1",
            "#subscription-auto-update-enable: 1",
            "#subscriptions-expand-now: 1",
            "#notification-subs-expire: 1",
            "#check-url-via-proxy: https://cp.cloudflare.com/generate_204",
            "#ping-result: time",
            "#proxy-ping-mode: keepalive",
            "#ping-type: proxy",
            ...Object.entries(APP_SETTINGS).map(([k, v]) => `#${k}: ${v}`),
            ...configs,
            ...staticConfigs,
        ].join("\n");

        const encoded = Buffer.from(output).toString("base64");
        return res.send(encoded);

    } catch (err) {
        return res.send("Error: " + err.message);
    }
});

app.listen(PORT, () => console.log(`Subscription proxy running on port ${PORT}`));
