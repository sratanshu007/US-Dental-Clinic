#!/usr/bin/env bash
# One-time setup on a fresh Amazon Linux 2023 EC2 instance (run as ec2-user with sudo).
#   curl -O <this file> && bash setup-ec2.sh
set -euo pipefail
sudo dnf update -y
sudo dnf install -y docker git postgresql16 cronie
sudo systemctl enable --now docker crond
sudo usermod -aG docker ec2-user
# docker compose v2 plugin
sudo mkdir -p /usr/local/lib/docker/cli-plugins
sudo curl -sSL "https://github.com/docker/compose/releases/latest/download/docker-compose-linux-$(uname -m)" \
  -o /usr/local/lib/docker/cli-plugins/docker-compose
sudo chmod +x /usr/local/lib/docker/cli-plugins/docker-compose
# Automatic security updates
sudo dnf install -y dnf-automatic
sudo sed -i 's/^apply_updates.*/apply_updates = yes/' /etc/dnf/automatic.conf
sudo systemctl enable --now dnf-automatic.timer
echo "Done. Log out and back in (docker group), then copy the project to ~/dental-ai-receptionist and follow AWS-SETUP.md step 6."
