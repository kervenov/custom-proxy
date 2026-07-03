#!/usr/bin/env bash
# ============================================
# custom-proxy — uzaktan tek satır kurulum
# ============================================
# Kullanım (VPS'te root olarak):
#   sudo bash -c "$(curl -sL https://github.com/kervenov/custom-proxy/raw/main/install.sh)"
#
# git+curl kurar -> repoyu indirir -> setup.sh'i çalıştırır.
set -euo pipefail

REPO="https://github.com/kervenov/custom-proxy.git"
DIR="/root/custom-proxy"

echo "==> Gerekli paketler (git, curl)..."
apt update
apt install -y git curl

echo "==> Repo indiriliyor -> $DIR"
if [ -d "$DIR/.git" ]; then
    git -C "$DIR" pull --ff-only
else
    rm -rf "$DIR"
    git clone "$REPO" "$DIR"
fi

echo "==> setup.sh çalıştırılıyor..."
cd "$DIR"
bash setup.sh
