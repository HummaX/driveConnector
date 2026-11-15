#!/usr/bin/env bash
# ==============================================================================
# DriveConnector - Automated Full Installation & Deployment Script
# Supports: Ubuntu 20.04 / 22.04 / 24.04 LTS & Debian 11 / 12
# ==============================================================================

set -e

# Parse command-line arguments
AUTO_MOUNT=0
for arg in "$@"; do
  case "$arg" in
    --auto-mount)
      AUTO_MOUNT=1
      ;;
  esac
done

# 1. Automatically escalate to sudo/root if run as non-root user
if [ "$EUID" -ne 0 ]; then
  echo "[i] Root privileges required. Re-running script with sudo..."
  exec sudo bash "$0" "$@"
fi

echo "======================================================================"
echo "    Starting DriveConnector Automated Server Setup"
echo "======================================================================"

TARGET_USER="${SUDO_USER:-$USER}"
if [ "$TARGET_USER" = "root" ] && [ -d "/home/ubuntu" ]; then
  TARGET_USER="ubuntu"
fi

# 2. Update package repositories & install foundational tools
echo "[+] Step 1/6: Updating package index and installing base dependencies..."
apt-get update -y
apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    gnupg \
    lsb-release \
    git \
    ufw \
    e2fsprogs \
    util-linux \
    aria2 \
    rclone

# Configure automated firewall rules (UFW)
echo "[+] Configuring firewall rules (UFW)..."
SSH_PORT=$(ss -tlnp 2>/dev/null | grep -E 'sshd|ssh' | awk '{print $4}' | awk -F':' '{print $NF}' | head -n1)
if [ -z "$SSH_PORT" ]; then
    SSH_PORT=$(grep -E '^Port ' /etc/ssh/sshd_config 2>/dev/null | awk '{print $2}' | head -n1)
fi
SSH_PORT=${SSH_PORT:-22}
ufw allow 22
if [ "$SSH_PORT" != "22" ]; then
    ufw allow "$SSH_PORT"/tcp
fi
ufw allow 80
ufw allow 8000
ufw --force enable

# 3. Ensure Repository Code is Present (Handle running outside repo or via curl | bash)
REPO_DIR="$(pwd)"
if [ ! -f "$REPO_DIR/docker-compose.yml" ] || [ ! -f "$REPO_DIR/.env.example" ]; then
    if [ -n "$TARGET_USER" ] && [ "$TARGET_USER" != "root" ] && [ -d "/home/$TARGET_USER" ]; then
        REPO_DIR="/home/$TARGET_USER/driveConnector"
    elif [ -d "/home/ubuntu" ]; then
        REPO_DIR="/home/ubuntu/driveConnector"
    else
        REPO_DIR="/opt/driveConnector"
    fi

    if [ -d "$REPO_DIR/.git" ]; then
        echo "[+] Found existing repository at $REPO_DIR. Pulling latest code..."
        cd "$REPO_DIR"
        git fetch origin main || true
        git reset --hard origin/main || true
    else
        echo "[+] Repository not detected in current directory. Cloning into $REPO_DIR..."
        mkdir -p "$(dirname "$REPO_DIR")"
        git clone https://github.com/HummaX/driveConnector.git "$REPO_DIR"
        cd "$REPO_DIR"
    fi

    if [ -n "$TARGET_USER" ] && id "$TARGET_USER" &>/dev/null; then
        chown -R "$TARGET_USER:$TARGET_USER" "$REPO_DIR" 2>/dev/null || true
    fi
else
    cd "$REPO_DIR"
fi

# 4. Install Docker and Docker Compose Plugin
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
    usermod -aG docker "$TARGET_USER" 2>/dev/null || true
    echo "[+] Added user '$TARGET_USER' to docker group."
fi

# 5. Prepare OVHcloud 1TB Block Storage Mount and Storage Directories
STORAGE_DIR="/mnt/storage"
echo "[+] Step 3/6: Checking Block Storage and storage directories at $STORAGE_DIR..."

if mountpoint -q "$STORAGE_DIR"; then
    echo "[+] $STORAGE_DIR is already mounted ($(df -h "$STORAGE_DIR" | awk 'NR==2 {print $1 " (" $2 " total)"}'))."
else
    # Detect secondary block device (>= 500GB, unmounted, not root disk)
    TARGET_DISK=""
    ROOT_DISK=$(lsblk -n -o PKNAME "$(findmnt -n -o SOURCE / 2>/dev/null)" 2>/dev/null || true)
    if [ -z "$ROOT_DISK" ]; then
        ROOT_DISK=$(findmnt -n -o SOURCE / 2>/dev/null | sed -E 's#/dev/([a-z]+)[0-9]+#\1#' | sed -E 's#/dev/##')
    fi

    while read -r d_name d_size d_type d_mount; do
        [ "$d_type" != "disk" ] && continue
        [ "$d_name" = "$ROOT_DISK" ] && continue
        [ -n "$d_mount" ] && continue

        # Check if disk has any mounted partition
        has_mount=$(lsblk -n -o MOUNTPOINT "/dev/$d_name" 2>/dev/null | grep -v '^$' || true)
        [ -n "$has_mount" ] && continue

        # Check if disk size >= 500 GB (500000000000 bytes)
        if [ "$d_size" -ge 500000000000 ] 2>/dev/null; then
            TARGET_DISK="/dev/$d_name"
            break
        fi
    done < <(lsblk -b -d -n -o NAME,SIZE,TYPE,MOUNTPOINT 2>/dev/null || true)

    if [ -n "$TARGET_DISK" ]; then
        DISK_HR_SIZE=$(lsblk -d -n -o SIZE "$TARGET_DISK" 2>/dev/null || echo "1TB")
        echo "[!] Detected unmounted high-capacity block storage: $TARGET_DISK ($DISK_HR_SIZE)"

        DO_MOUNT=0
        if [ "$AUTO_MOUNT" -eq 1 ]; then
            DO_MOUNT=1
            echo "[+] --auto-mount flag detected. Formatting and mounting $TARGET_DISK..."
        elif [ -t 0 ]; then
            read -r -p "    Format $TARGET_DISK as ext4 and mount to $STORAGE_DIR? [Y/n] " prompt_ans
            case "$prompt_ans" in
                [nN][oO]|[nN])
                    echo "[!] Skipping block storage mount. Using host root drive."
                    ;;
                *)
                    DO_MOUNT=1
                    ;;
            esac
        elif [ -t 1 ] && [ -r /dev/tty ]; then
            read -r -p "    Format $TARGET_DISK as ext4 and mount to $STORAGE_DIR? [Y/n] " prompt_ans < /dev/tty
            case "$prompt_ans" in
                [nN][oO]|[nN])
                    echo "[!] Skipping block storage mount. Using host root drive."
                    ;;
                *)
                    DO_MOUNT=1
                    ;;
            esac
        else
            echo "[!] Non-interactive mode without --auto-mount. Skipping automatic formatting."
            echo "[!] To mount $TARGET_DISK automatically, re-run with: sudo bash setup.sh --auto-mount"
        fi

        if [ "$DO_MOUNT" -eq 1 ]; then
            echo "[+] Wiping signatures on $TARGET_DISK..."
            wipefs -a "${TARGET_DISK}"?* "$TARGET_DISK" 2>/dev/null || true
            echo "[+] Formatting $TARGET_DISK as ext4..."
            mkfs.ext4 -F -m 1 "$TARGET_DISK"
            mkdir -p "$STORAGE_DIR"
            mount "$TARGET_DISK" "$STORAGE_DIR"

            DISK_UUID=$(blkid -s UUID -o value "$TARGET_DISK" 2>/dev/null || true)
            if [ -n "$DISK_UUID" ]; then
                if ! grep -q "$DISK_UUID" /etc/fstab && ! grep -q "$STORAGE_DIR" /etc/fstab; then
                    echo "UUID=$DISK_UUID $STORAGE_DIR ext4 defaults,nofail 0 2" >> /etc/fstab
                    echo "[+] Persisted $TARGET_DISK (UUID=$DISK_UUID) in /etc/fstab."
                fi
                systemctl daemon-reload 2>/dev/null || true
            fi
            echo "[+] Successfully mounted $TARGET_DISK at $STORAGE_DIR ($(df -h "$STORAGE_DIR" | awk 'NR==2 {print $2 " total, " $4 " free"}'))."
        fi
    else
        echo "[i] No unmounted secondary block storage (>= 500GB) detected. Proceeding with $STORAGE_DIR on root drive."
    fi
fi

# Ensure subdirectories and permission hierarchy
mkdir -p "$STORAGE_DIR/mongodb" "$STORAGE_DIR/videos" "$STORAGE_DIR/metadata" "$STORAGE_DIR/config" "$STORAGE_DIR/jdownloader/cfg" "$STORAGE_DIR/jdownloader/folderwatch"
if [ ! -f "$STORAGE_DIR/jdownloader/cfg/org.jdownloader.extensions.folderwatch.FolderWatchExtension.json" ]; then
    cat << 'EOF' > "$STORAGE_DIR/jdownloader/cfg/org.jdownloader.extensions.folderwatch.FolderWatchExtension.json"
{
  "enabled" : true
}
EOF
fi
if [ ! -f "$STORAGE_DIR/jdownloader/cfg/org.jdownloader.settings.GeneralSettings.json" ]; then
    cat << 'EOF' > "$STORAGE_DIR/jdownloader/cfg/org.jdownloader.settings.GeneralSettings.json"
{
  "defaultdownloadfolder" : "/output"
}
EOF
fi
chown -R 1000:1000 "$STORAGE_DIR/videos" "$STORAGE_DIR/metadata" "$STORAGE_DIR/config" "$STORAGE_DIR/jdownloader" 2>/dev/null || true
chmod 775 "$STORAGE_DIR" 2>/dev/null || true
chmod -R 775 "$STORAGE_DIR/videos" "$STORAGE_DIR/metadata" "$STORAGE_DIR/config" "$STORAGE_DIR/jdownloader" 2>/dev/null || true
chown -R 999:999 "$STORAGE_DIR/mongodb" 2>/dev/null || true
chmod 750 "$STORAGE_DIR/mongodb" 2>/dev/null || true

# Ensure safeguard placeholder template JSON files exist in backend before docker compose up
if [ ! -f "$REPO_DIR/backend/credentials.json" ]; then
    echo "{}" > "$REPO_DIR/backend/credentials.json"
fi
if [ ! -f "$REPO_DIR/backend/token.json" ]; then
    echo "{}" > "$REPO_DIR/backend/token.json"
fi
if [ ! -f "./backend/credentials.json" ]; then
    echo "{}" > "./backend/credentials.json"
fi
if [ ! -f "./backend/token.json" ]; then
    echo "{}" > "./backend/token.json"
fi

# 6. Configuration & Symlinks
echo "[+] Step 4/6: Checking environment configuration & installing CLI tools..."
if [ ! -f .env ]; then
    echo "[+] Generating .env from .env.example..."
    cp .env.example .env
    RANDOM_JWT=$(openssl rand -hex 32 2>/dev/null || tr -dc 'a-zA-Z0-9' < /dev/urandom | head -c 64)
    if [ -n "$RANDOM_JWT" ]; then
        sed -i "s#JWT_SECRET_KEY=.*#JWT_SECRET_KEY=$RANDOM_JWT#" .env
    fi
fi

# Install global update symlink
chmod +x "$REPO_DIR/update.sh" 2>/dev/null || true
ln -sf "$REPO_DIR/update.sh" /usr/local/bin/driveconnector-update
echo "[+] Installed global CLI shortcut: driveconnector-update -> $REPO_DIR/update.sh"

# 7. Build and launch Docker Compose stack
echo "[+] Step 5/6: Building and starting DriveConnector stack..."
docker compose down --remove-orphans 2>/dev/null || true
docker compose up -d --build

# 8. Verification and status display
echo "[+] Step 6/6: Verifying container health..."
sleep 5
docker compose ps

# Detect server public IP
SERVER_IP=$(curl -s -4 ifconfig.me 2>/dev/null || curl -s icanhazip.com 2>/dev/null || hostname -I | awk '{print $1}')

echo ""
echo "======================================================================"
echo "    🚀 DriveConnector Media Server is ONLINE & READY!"
echo "======================================================================"
echo "  Web Streaming UI  : http://$SERVER_IP/ (or direct http://$SERVER_IP:8000/)"
echo "  API Documentation : http://$SERVER_IP:8000/docs"
echo "  Mongo Express UI  : http://127.0.0.1:8081/ (or public if configured in .env)"
echo "  Storage Mount     : $STORAGE_DIR ($(df -h "$STORAGE_DIR" | awk 'NR==2 {print $2 " total, " $4 " available"}'))"
echo ""
echo "  Admin Login Credentials:"
echo "    Username : admin"
echo "    Password : Admin@Drive2026!"
echo ""
echo "  SSH Tunnel for Mongo Express (if bound to 127.0.0.1):"
echo "    ssh -L 8081:127.0.0.1:8081 ubuntu@$SERVER_IP"
echo "======================================================================"
echo "  Useful Commands:"
echo "    View logs   : cd $REPO_DIR && docker compose logs -f"
echo "    Stop server : cd $REPO_DIR && docker compose down"
echo "    Restart     : cd $REPO_DIR && docker compose restart"
echo "    Update code : driveconnector-update (from any directory)"
echo "======================================================================"
