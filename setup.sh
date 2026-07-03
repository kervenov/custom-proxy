#!/usr/bin/env bash
# ============================================
# custom-proxy — tek komut kurulum
# ============================================
# Kullanım (VPS'te, root olarak):
#   1) domains.json içindeki değerleri kendi bilgilerinle doldur
#   2) bash setup.sh
#
# Yaptıkları: Node.js kurar (yoksa) -> domains.json'u okur -> .env yazar
# -> paketleri kurar -> systemd servisini başlatır -> fail2ban kurar
# -> (opsiyonel) Nginx + Let's Encrypt SSL kurar.
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVICE="sub-backend"
CFG="$APP_DIR/domains.json"

echo "==> custom-proxy kurulum ($APP_DIR)"
[ -f "$CFG" ] || { echo "HATA: domains.json bulunamadı ($CFG)"; exit 1; }

# 1) Node.js (yoksa kur)
if ! command -v node >/dev/null 2>&1; then
    echo "==> Node.js kuruluyor (18.x)..."
    curl -fsSL https://deb.nodesource.com/setup_18.x | bash -
    apt install -y nodejs
fi
echo "==> Node: $(node -v)"

# 2) domains.json oku (node ile — jq gerekmez)
jsget() { node -e "const c=require(process.argv[1]); const v=c[process.argv[2]]; process.stdout.write(v==null?'':String(v))" "$CFG" "$1"; }
PORT="$(jsget port)";          PORT="${PORT:-8080}"
PROVIDER_ID="$(jsget provider_id)"
BACKUP_DOMAIN="$(jsget backup_domain)"
UPSTREAM_URL="$(jsget upstream_url)"
EMAIL="$(jsget email)"
DOMAINS="$(node -e "const c=require(process.argv[1]); process.stdout.write((c.domains||[]).join(' '))" "$CFG")"
echo "==> Config: port=$PORT provider=$PROVIDER_ID domains=[$DOMAINS]"

# 3) .env yaz (index.js bunu okur; git'e gönderilmez)
cat > "$APP_DIR/.env" <<EOF
PORT=$PORT
PROVIDER_ID=$PROVIDER_ID
BACKUP_DOMAIN=$BACKUP_DOMAIN
UPSTREAM_URL=$UPSTREAM_URL
EOF
echo "==> .env yazıldı"

# 4) Paketler
echo "==> npm install..."
( cd "$APP_DIR" && npm install --omit=dev )

# 5) systemd servisi
cat > "/etc/systemd/system/$SERVICE.service" <<EOF
[Unit]
Description=Subscription Proxy
After=network.target

[Service]
ExecStart=$(command -v node) $APP_DIR/index.js
Restart=always
User=root
WorkingDirectory=$APP_DIR

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable "$SERVICE"
systemctl restart "$SERVICE"
echo "==> Servis çalışıyor (port $PORT)"

# 6) fail2ban — SSH brute-force (5 deneme -> 5 saat ban)
echo "==> fail2ban kuruluyor..."
apt install -y fail2ban
cat > /etc/fail2ban/jail.local <<'EOF'
[DEFAULT]
# 1 saat içinde 5 başarısız deneme -> 5 saat ban
findtime = 1h
maxretry = 5
bantime  = 5h
backend  = systemd

[sshd]
enabled = true
EOF
systemctl enable fail2ban
systemctl restart fail2ban
echo "==> fail2ban aktif (maxretry=5, bantime=5h)"

# 7) Firewall (ufw) — SSH/HTTP/HTTPS açık; 8080 dışarıya KAPALI (yalnızca nginx erişir)
echo "==> ufw yapılandırılıyor..."
apt install -y ufw
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable
echo "==> ufw aktif (22/80/443 açık, 8080 kapalı)"

# 8) Nginx + SSL (opsiyonel — domainler bu VPS IP'sine yönlenmiş olmalı)
read -rp "Nginx + SSL (Let's Encrypt) kurulsun mu? [y/N]: " DOSSL || DOSSL="n"
if [ "$(printf '%s' "${DOSSL:-}" | tr '[:upper:]' '[:lower:]')" = "y" ]; then
    [ -n "$DOMAINS" ] || { echo "HATA: domains.json içinde domain yok"; exit 1; }
    [ -n "$EMAIL" ]   || { echo "HATA: domains.json içinde email yok (certbot için gerekli)"; exit 1; }
    PRIMARY="$(printf '%s' "$DOMAINS" | awk '{print $1}')"
    apt install -y nginx certbot

    # 8a) HTTP nginx (acme-challenge + /sub proxy)
    mkdir -p /var/www/html/.well-known/acme-challenge
    cat > /etc/nginx/sites-available/subscription <<EOF
server {
    listen 80;
    server_name $DOMAINS;

    location ^~ /.well-known/acme-challenge/ {
        root /var/www/html;
        default_type "text/plain";
    }

    location /sub/ {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    location / { return 301 https://trustpilot.com; }
}
EOF
    rm -f /etc/nginx/sites-enabled/default
    ln -sf /etc/nginx/sites-available/subscription /etc/nginx/sites-enabled/subscription
    nginx -t && systemctl reload nginx

    # 8b) certbot — tüm domainler tek sertifika
    CB_ARGS=""
    for d in $DOMAINS; do CB_ARGS="$CB_ARGS -d $d"; done
    certbot certonly --webroot -w /var/www/html \
        --deploy-hook "systemctl reload nginx" \
        --non-interactive --agree-tos --expand -m "$EMAIL" $CB_ARGS

    # 8c) HTTPS nginx (sertifika alındıktan sonra)
    [ -f /etc/letsencrypt/options-ssl-nginx.conf ] || \
        curl -fsSL https://raw.githubusercontent.com/certbot/certbot/master/certbot-nginx/certbot_nginx/_internal/tls_configs/options-ssl-nginx.conf \
        -o /etc/letsencrypt/options-ssl-nginx.conf
    [ -f /etc/letsencrypt/ssl-dhparams.pem ] || openssl dhparam -out /etc/letsencrypt/ssl-dhparams.pem 2048

    cat > /etc/nginx/sites-available/subscription <<EOF
server {
    listen 443 ssl http2;
    server_name $DOMAINS;

    ssl_certificate /etc/letsencrypt/live/$PRIMARY/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$PRIMARY/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

    location /sub/ {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    location / { return 301 https://trustpilot.com; }
}

server {
    listen 80;
    server_name $DOMAINS;

    location ^~ /.well-known/acme-challenge/ {
        root /var/www/html;
        default_type "text/plain";
    }

    location / { return 301 https://\$host\$request_uri; }
}
EOF
    nginx -t && systemctl reload nginx
    echo "==> Nginx + SSL hazır: https://$PRIMARY"
fi

echo ""
echo "==> Bitti."
echo "    Durum:   systemctl status $SERVICE"
echo "    Log:     journalctl -u $SERVICE -f"
echo "    fail2ban: fail2ban-client status sshd"
echo "    Test:    curl -i http://127.0.0.1:$PORT/sub/TOKEN"
