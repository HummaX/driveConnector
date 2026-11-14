#!/usr/bin/env bash
# ==============================================================================
# DriveConnector - Automated Full Installation & Deployment Script
# Supports: Ubuntu 20.04 / 22.04 / 24.04 LTS & Debian 11 / 12
# ==============================================================================

set -e

# 1. Automatically escalate to sudo/root if run as non-root user
if [ "$EUID" -ne 0 ]; then
  echo "[i] Root privileges required. Re-running script with sudo..."
  exec sudo bash "$0" "$@"
fi

echo "======================================================================"
echo "    Starting DriveConnector Automated Server Setup"
echo "======================================================================"

TARGET_USER="${SUDO_USER:-$USER}"

# 2. Update package repositories & install foundational tools
echo "[+] Step 1/6: Updating package index and installing base dependencies..."
apt-get update -y
apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    gnupg \
    lsb-release \
    git \
    ufw

# 3. Install Docker and Docker Compose Plugin
if ! command -v docker &> /dev/null; then
    echo "[+] Step 2/6: Installing Docker Engine & Compose..."
    mkdir -p /etc/apt/keyrings
    
    # Try official Docker repository first
    if curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg --yes 2>/dev/null; then
        DISTRO=$(lsb_release -is | tr '[:upper:]' '[:lower:]')
        CODENAME=$(lsb_release -cs)
        echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/$DISTRO $CODENAME stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null
        apt-get update -y
        apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin || {
            echo "[!] Official Docker repo fallback to standard Ubuntu docker packages..."
            apt-get install -y docker.io docker-compose-v2
        }
    else
        apt-get install -y docker.io docker-compose-v2
    fi
else
    echo "[+] Step 2/6: Docker is already installed: $(docker --version)"
fi

# Ensure docker service is enabled and started
systemctl enable --now docker

# Add non-root executing user to docker group
if [ -n "$TARGET_USER" ] && [ "$TARGET_USER" != "root" ]; then
    usermod -aG docker "$TARGET_USER"
    echo "[+] Added user '$TARGET_USER' to docker group."
fi

# 4. Prepare OVHcloud 1TB Block Storage Mount directories
STORAGE_DIR="/mnt/storage"
echo "[+] Step 3/6: Setting up block storage volume directories at $STORAGE_DIR..."
mkdir -p "$STORAGE_DIR/mongodb" "$STORAGE_DIR/videos" "$STORAGE_DIR/metadata"

# UID 999 for official MongoDB container, 1000 for media assets
chown -R 999:999 "$STORAGE_DIR/mongodb" 2>/dev/null || true
chown -R 1000:1000 "$STORAGE_DIR/videos" "$STORAGE_DIR/metadata" 2>/dev/null || true
chmod -R 775 "$STORAGE_DIR"

# 5. Configuration & Git Code Update
echo "[+] Step 4/6: Checking environment configuration & pulling latest git updates..."
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if [ ! -f .env ]; then
    echo "[+] Generating .env from .env.example..."
    cp .env.example .env
fi

if [ -d .git ]; then
    echo "[+] Pulling latest production code from GitHub (main)..."
    git fetch origin main || true
    git reset --hard origin/main || true
fi

# 6. Build and launch Docker Compose stack
echo "[+] Step 5/6: Building and starting DriveConnector stack..."
docker compose down --remove-orphans 2>/dev/null || true
docker compose up -d --build

# 7. Verification and status display
echo "[+] Step 6/6: Verifying container health..."
sleep 5
docker compose ps

# Detect server public IP
SERVER_IP=$(curl -s -4 ifconfig.me 2>/dev/null || curl -s icanhazip.com 2>/dev/null || hostname -I | awk '{print $1}')

echo ""
echo "======================================================================"
echo "    🚀 DriveConnector Media Server is ONLINE & READY!"
echo "======================================================================"
echo "  Web Streaming UI  : http://$SERVER_IP:8000/"
echo "  API Documentation : http://$SERVER_IP:8000/docs"
echo "  Mongo Express UI  : http://127.0.0.1:8081/ (via SSH tunnel)"
echo ""
echo "  Admin Login Credentials:"
echo "    Username : admin"
echo "    Password : Admin@Drive2026!"
echo "======================================================================"
echo "  Useful Commands:"
echo "    View logs   : cd $SCRIPT_DIR && docker compose logs -f"
echo "    Stop server : cd $SCRIPT_DIR && docker compose down"
echo "    Restart     : cd $SCRIPT_DIR && docker compose restart"
echo "    Update code : cd $SCRIPT_DIR && bash update.sh"
echo "======================================================================"
