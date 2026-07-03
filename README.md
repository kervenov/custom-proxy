# custom-proxy

Marzban subscription proxy backend. Hafif Node.js + Express, sıfır ekstra bağımlılık (sadece `express` + `axios`). Tüm ayarlar `domains.json` içinde.

Özellikler:
- **Domain başına** ayrı `providerId` + yedek (`backup`) URL
- Xray JSON config'lerini (vless/vmess/hysteria2/shadowsocks) URI'ye çeviren statik config yükleyici
- Gerçek `User-Agent` + HWID/cihaz header'larını panele forward etme
- Zengin subscription header seti (`new-domain`, `fallback-url`, `hide-settings`, hwid, auto-update vb.)

## Kurulum (VPS'te tek satır)

git kurulu olmasa bile çalışır — git+curl'u kurar, repoyu indirir, `setup.sh`'i başlatır:

```bash
sudo bash -c "$(curl -sL https://github.com/kervenov/custom-proxy/raw/main/install.sh)"
```

Alternatif (git zaten kuruluysa):

```bash
git clone https://github.com/kervenov/custom-proxy.git
cd custom-proxy
bash setup.sh
```

> `domains.json` gerçek değerlerle dolu gelir; farklı ayar istersen `/root/custom-proxy/domains.json`'u düzenleyip `bash setup.sh` çalıştır.

`setup.sh` sırayla: Node.js kurar (yoksa) → `domains.json`'u okur → paketleri kurar → systemd servisini başlatır → **fail2ban** kurar (SSH: 5 başarısız deneme → 5 saat ban) → **ufw** firewall açar (22/80/443 açık, 8080 dışarıya kapalı) → sorarsa **Nginx + Let's Encrypt SSL** kurar (otomatik yenileme + nginx reload dahil, geçerli sertifika varsa yeniden almaz).

## Sadece kodu güncelleme (sertifikaya dokunmadan)

`index.js`/`domains.json` değişti ama SSL zaten kuruluysa, `setup.sh` çalıştırma — certbot'u tekrar tetiklemesin:

```bash
cd /root/custom-proxy
git pull
systemctl restart sub-backend
```

## Ayarlar (domains.json)

```json
{
  "port": 8080,
  "email": "you@example.com",
  "upstream_url": "https://panel.example.com:10086/sub/",
  "static_configs_path": "/root/vpn-config.json",
  "default": { "providerId": "YOUR_PROVIDER_ID", "backup": "https://www.example.com/sub/" },
  "domains": {
    "www.example.com": { "providerId": "PROVIDER_A", "backup": "https://www.example.com/sub/" },
    "sub.example.net": { "providerId": "PROVIDER_B", "backup": "https://sub.example.net/sub/" }
  }
}
```

| Alan | Açıklama |
|------|----------|
| `port` | Backend portu (Nginx buraya proxy yapar) |
| `email` | Let's Encrypt bildirim e-postası |
| `upstream_url` | Panelin gerçek backend adresi (`/sub/` ile bitmeli) |
| `static_configs_path` | Statik config dosyası yolu (opsiyonel, yoksa atlanır) |
| `default` | Bilinmeyen host için `{ providerId, backup }` |
| `domains` | Domain → `{ providerId, backup }`. Key'ler aynı zamanda Nginx + SSL sertifikasına eklenir (ilki ana sertifika adı) |

`index.js` gelen isteğin `Host` başlığına göre ilgili domainin `providerId`/`backup` değerini seçer; eşleşme yoksa `default` kullanılır.

### Statik config'ler (opsiyonel)
`static_configs_path` (varsayılan `/root/vpn-config.json`) bir Xray JSON config (veya dizi) ya da satır satır `vless://`/`vmess://`/`ss://`/`hysteria2://` URI listesi olabilir. Dosya yoksa sessizce atlanır.

> ⚠️ **Güvenlik:** `domains.json` gerçek domain/panel bilgilerini içerir. Bu repo **private** olmalı — public yapma, aksi halde tüm domain listesi ve panel backend adresi herkese açık olur.

## Servis komutları

```bash
systemctl status sub-backend      # durum
journalctl -u sub-backend -f      # canlı log
systemctl restart sub-backend     # yeniden başlat
fail2ban-client status sshd       # ban listesi
```
