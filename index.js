// .env yükle (dotenv'siz, sıfır bağımlılık)
try {
    for (const line of require("fs").readFileSync(__dirname + "/.env", "utf8").split("\n")) {
        const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
    }
} catch {}

const express = require("express");
const axios = require("axios");
const app = express();

/* ================================
   1) Ayarlar (.env üzerinden)
=================================== */
const PORT = process.env.PORT || 8080;
const PROVIDER_ID = process.env.PROVIDER_ID || "HnBuVTvc";
const BACKUP_DOMAIN = process.env.BACKUP_DOMAIN || "https://www.cyber-x.fun/sub/";
const UPSTREAM_URL = process.env.UPSTREAM_URL || "https://ze.cyber-x.online:10086/sub/";

/* ================================
   2) Subscription Proxy
=================================== */
app.get("/sub/:data", async (req, res) => {

    // Panelin ana backend adresi
    const realUrl = `${UPSTREAM_URL}${req.params.data}`;

    try {
        const response = await axios.get(realUrl, {
            responseType: "text",
            validateStatus: () => true
        });

        if (response.status !== 200) {
            return res.send("Error: " + response.status);
        }

        let b64 = response.data.trim();
        let decoded;

        // Base64 mi değil mi?
        try {
            decoded = Buffer.from(b64, "base64").toString().split(/\r?\n/);
        } catch (err) {
            decoded = b64.split(/\r?\n/);
        }

        // Kullanıcı veri bilgileri
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

        // Sadece gerçek config satırları
        const configs = decoded.filter(line =>
            /^(ss|vless|vmess|trojan):\/\//.test(line.trim())
        );

        // Kullanıcının token'i
        const userToken = encodeURIComponent(req.params.data);

        /* ================================
           3) HEADER New-URL + ProviderID
         =================================== */
        res.set("new-url", `${BACKUP_DOMAIN}${userToken}`);
        res.set("providerid", PROVIDER_ID);

        /* ================================
           4) BODY üretimi
        =================================== */
        const output = [
            "#profile-title: base64:4pqc77iPIEPKj8qZ4bSHyoBYIOKanO+4jw==",
            "#profile-update-interval: 1",
            "#support-url: https://t.me/CybeR_CollectivE",
            "#profile-web-page-url: https://ipinfo.io/what-is-my-ip",
            "#announce: base64:8J+UhCDQn9C+0LTQv9C40YHQutCwINC+0LHQvdC+0LLQu9GP0LXRgtGB0Y8g0LrQsNC20LTRi9C5INGH0LDRgSEg8J+UhArimqDvuI8g0J/RgNC4INC/0YDQvtCx0LvQtdC80LDRhSDQv9C10YDQtdC30LDQs9GA0YPQt9C40YLQtSDRg9GB0YLRgNC+0LnRgdGC0LLQviDQuCDQtNC+0LHQsNCy0YzRgtC1INGB0YHRi9C70LrRgyDQt9Cw0L3QvtCy0L4uIOKaoO+4jw==",
            `#subscription-userinfo: upload=${upload}; download=${download}; total=${total}; expire=${expire}`,

            `#new-url ${BACKUP_DOMAIN}${userToken}`,
            `#providerid ${PROVIDER_ID}`,

            ...configs
        ].join("\n");

        const encoded = Buffer.from(output).toString("base64");
        return res.send(encoded);

    } catch (err) {
        return res.send("Error: " + err.message);
    }
});

app.listen(PORT, () => console.log(`Subscription proxy running on port ${PORT}`));
