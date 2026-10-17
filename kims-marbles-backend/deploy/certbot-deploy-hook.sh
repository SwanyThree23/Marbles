#!/bin/bash
# /etc/letsencrypt/renewal-hooks/deploy/kims-marbles.sh — runs after every issue/renewal.
# coturn runs as its own user and cannot read /etc/letsencrypt/live, so give it a copy.
set -euo pipefail
LIVE=/etc/letsencrypt/live/vibenbones.online
install -d -m 750 -o turnserver -g turnserver /etc/coturn/certs
install -m 640 -o turnserver -g turnserver "$LIVE/fullchain.pem" /etc/coturn/certs/fullchain.pem
install -m 640 -o turnserver -g turnserver "$LIVE/privkey.pem" /etc/coturn/certs/privkey.pem
systemctl restart coturn || true
systemctl reload nginx || true
