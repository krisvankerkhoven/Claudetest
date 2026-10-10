#!/usr/bin/env bash
# Deploy naar de VPS via SSH + rsync. Idempotent: opnieuw draaien = updaten.
#   ./deploy.sh                 code syncen, afhankelijkheden, systemd + cron, herstart, healthcheck
#   ./deploy.sh --push-env      idem, en kopieert je lokale .env naar de server (chmod 600)
# Config: omgevingsvariabelen of deploy/.deploy.env (staat in .gitignore)
#   DEPLOY_HOST=root@1.2.3.4   (verplicht)    DEPLOY_PATH=/opt/wijnlog   DEPLOY_PORT=22
set -euo pipefail
cd "$(dirname "$0")"
[ -f deploy/.deploy.env ] && . deploy/.deploy.env

HOST="${DEPLOY_HOST:?Zet DEPLOY_HOST, bv. root@1.2.3.4 (of in deploy/.deploy.env)}"
APP_DIR="${DEPLOY_PATH:-/opt/wijnlog}"
PORT="${DEPLOY_PORT:-22}"
PUSH_ENV=0; [ "${1:-}" = "--push-env" ] && PUSH_ENV=1
SSH=(ssh -p "$PORT" -o ServerAliveInterval=15 "$HOST")

SUDO=$("${SSH[@]}" '[ "$(id -u)" = 0 ] || echo sudo')
echo "==> Doel: $HOST:$APP_DIR ${SUDO:+(via sudo)}"

echo "==> Map voorbereiden"
"${SSH[@]}" "$SUDO mkdir -p '$APP_DIR'"

echo "==> Code synchroniseren (data/ en .env blijven onaangeroerd)"
rsync -az --delete -e "ssh -p $PORT" --rsync-path="${SUDO:+sudo }rsync" \
  --exclude '.git' --exclude '__pycache__' --exclude '.pytest_cache' --exclude '.venv' \
  --exclude 'data/' --exclude '.env' --exclude 'deploy/.deploy.env' --exclude 'tests/' \
  ./ "$HOST:$APP_DIR/"

if [ "$PUSH_ENV" = 1 ]; then
  [ -f .env ] || { echo "Geen lokale .env gevonden" >&2; exit 1; }
  echo "==> .env kopiëren"
  scp -P "$PORT" -q .env "$HOST:/tmp/wijnlog.env.$$"
  "${SSH[@]}" "$SUDO install -m 600 /tmp/wijnlog.env.$$ '$APP_DIR/.env' && rm -f /tmp/wijnlog.env.$$"
fi

echo "==> Server inrichten"
"${SSH[@]}" "$SUDO bash -s -- '$APP_DIR'" <<'REMOTE'
set -euo pipefail
APP_DIR="$1"; USER_NAME=wijnlog

command -v python3 >/dev/null || { apt-get update -qq && apt-get install -y -qq python3; }
python3 -c 'import venv, ensurepip' 2>/dev/null || { apt-get update -qq && apt-get install -y -qq python3-venv; }
command -v curl >/dev/null || apt-get install -y -qq curl

id "$USER_NAME" >/dev/null 2>&1 || useradd -r -m -d "/home/$USER_NAME" -s /usr/sbin/nologin "$USER_NAME"
mkdir -p "$APP_DIR/data"
if [ ! -f "$APP_DIR/.env" ]; then
  cp "$APP_DIR/.env.example" "$APP_DIR/.env"
  echo "!! Nieuwe .env aangemaakt uit .env.example: vul die in op de server of gebruik --push-env"
fi
chmod 600 "$APP_DIR/.env"
chown -R "$USER_NAME": "$APP_DIR"

[ -d "$APP_DIR/.venv" ] || sudo -u "$USER_NAME" python3 -m venv "$APP_DIR/.venv" 2>/dev/null \
  || python3 -m venv "$APP_DIR/.venv"
chown -R "$USER_NAME": "$APP_DIR/.venv"
sudo -u "$USER_NAME" "$APP_DIR/.venv/bin/pip" install -q --upgrade pip
sudo -u "$USER_NAME" "$APP_DIR/.venv/bin/pip" install -q -r "$APP_DIR/requirements.txt"

sed "s#/opt/wijnlog#$APP_DIR#g" "$APP_DIR/deploy/wijnlog.service" > /etc/systemd/system/wijnlog.service
sed -e '/^#/d' -e '/^$/d' -e "s#cd /opt/wijnlog#cd $APP_DIR#" -e "s#^\(\S\+ \S\+ \S\+ \S\+ \S\+\) #\1 $USER_NAME #" \
  "$APP_DIR/deploy/crontab.example" > /etc/cron.d/wijnlog
chmod 644 /etc/cron.d/wijnlog

systemctl daemon-reload
systemctl enable wijnlog >/dev/null 2>&1
systemctl restart wijnlog

for i in 1 2 3 4 5 6 7 8 9 10; do
  curl -fsS http://127.0.0.1:8000/health >/dev/null 2>&1 && { echo "==> Healthcheck OK"; break; }
  [ "$i" = 10 ] && { echo "!! Service reageert niet. journalctl -u wijnlog -n 50" >&2; exit 1; }
  sleep 1
done

grep -qE '^WA_APP_SECRET=.+' "$APP_DIR/.env" || echo "!! WA_APP_SECRET is leeg: elke webhook-POST wordt geweigerd tot je dit invult"
grep -qE '^WA_ACCESS_TOKEN=.+' "$APP_DIR/.env" || echo "!! WA_ACCESS_TOKEN is leeg: antwoorden versturen faalt"
REMOTE
echo "==> Klaar. Logs: ssh $HOST 'journalctl -u wijnlog -f'"
