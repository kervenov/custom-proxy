# custom-proxy

Marzban subscription proxy backend. Hafif Node.js + Express, sıfır ekstra bağımlılık (sadece `express` + `axios`). Tüm ayarlar `domains.json` içinde.

## Kurulum (VPS'te tek seferde kopyala-yapıştır)

```bash
git clone https://github.com/kervenov/custom-proxy.git
cd custom-proxy
bash setup.sh
```

> `domains.json` gerçek değerlerle dolu gelir; farklı ayar istersen `bash setup.sh` öncesi düzenle.

`setup.sh` sırayla: Node.js kurar (yoksa) → `domains.json`'u okur → `.env` yazar → paketleri kurar → systemd servisini başlatır → **fail2ban** kurar (SSH: 5 başarısız deneme → 5 saat ban) → **ufw** firewall açar (22/80/443 açık, 8080 dışarıya kapalı) → sorarsa **Nginx + Let's Encrypt SSL** kurar (otomatik yenileme + nginx reload dahil).

## Ayarlar (domains.json)

```json
{
  "port": 8080,
  "provider_id": "YOUR_PROVIDER_ID",
  "backup_domain": "https://www.example.com/sub/",
  "upstream_url": "https://panel.example.com:10086/sub/",
  "email": "you@example.com",
  "domains": ["www.example.com", "sub.example.net"]
}
```

| Alan | Açıklama |
|------|----------|
| `port` | Backend portu (Nginx buraya proxy yapar) |
| `provider_id` | Marzban provider ID |
| `backup_domain` | Yedek domain (body + `new-url` header) |
| `upstream_url` | Panelin gerçek backend adresi (`/sub/` ile bitmeli) |
| `email` | Let's Encrypt bildirim e-postası |
| `domains` | Nginx + SSL sertifikasına eklenecek domainler (ilki ana sertifika adı) |

> ⚠️ **Güvenlik:** `domains.json` gerçek domain/panel bilgilerini içerir. Bu repo **private** olmalı — public yapma, aksi halde tüm domain listesi ve panel backend adresi herkese açık olur.

## Lokal çalıştırma

```bash
cp .env.example .env   # değerleri düzenle
npm install
npm start
```

## Servis komutları

```bash
systemctl status sub-backend      # durum
journalctl -u sub-backend -f      # canlı log
systemctl restart sub-backend     # yeniden başlat
fail2ban-client status sshd       # ban listesi
```
