#!/usr/bin/env bash
# Container entrypoint — mirrors the RPi startup (ErpNet.FP.DNS/scripts/rpi-startup.sh):
# self-provision on first run, register the LAN IP, fetch the wildcard cert if
# missing/expiring, then start ErpNet.FP.js with TLS.
#
# Required env:
#   DNS_SERVICE_URL   e.g. https://erpnet-fp-dns.t-core.io
#   INSTALL_TOKEN     shared first-boot provisioning token
# Optional env:
#   DEVICE_ID         stable id (default: derived from the primary MAC).
#                     Prefer setting this explicitly for containers.
#   CERT_DIR          default /data/certs (persist on a volume)
#   PORT              default 8001
#
# Run with host networking so LAN-IP detection/registration is correct and
# localhost services (e.g. a SIS emulator on :8199) are reachable.

set -euo pipefail

: "${DNS_SERVICE_URL:?DNS_SERVICE_URL is not set}"
: "${INSTALL_TOKEN:?INSTALL_TOKEN is not set}"
: "${CERT_DIR:=/data/certs}"
: "${PORT:=8001}"

CERT_FILE="$CERT_DIR/fullchain.pem"
KEY_FILE="$CERT_DIR/privkey.pem"
TOKEN_FILE="$CERT_DIR/device-token"
FQDN_FILE="$CERT_DIR/fqdn"
LOG="[erpnet-entrypoint]"

mkdir -p "$CERT_DIR"
chmod 700 "$CERT_DIR"

# ── Device ID ────────────────────────────────────────────────────────────────
if [[ -z "${DEVICE_ID:-}" ]]; then
  PRIMARY_IF=$(ip -4 route get 1.1.1.1 2>/dev/null \
    | awk '{for(i=1;i<=NF;i++) if($i=="dev") print $(i+1); exit}')
  MAC=$(cat "/sys/class/net/${PRIMARY_IF:-eth0}/address" 2>/dev/null | tr -d ':' || true)
  DEVICE_ID="rpi-${MAC:-unknown}"
fi
echo "$LOG Device ID: $DEVICE_ID"

# ── Self-provision on first run (token persisted on the volume) ───────────────
if [[ ! -f "$TOKEN_FILE" ]]; then
  echo "$LOG Provisioning with install token..."
  PROVISION_RESPONSE=$(curl -sf -X POST "$DNS_SERVICE_URL/api/provision" \
    -H "Authorization: Bearer $INSTALL_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"deviceId\": \"$DEVICE_ID\", \"name\": \"$DEVICE_ID\"}")
  DEVICE_TOKEN=$(echo "$PROVISION_RESPONSE" \
    | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")
  [[ -n "$DEVICE_TOKEN" ]] || { echo "$LOG ERROR: no token in provision response"; exit 1; }
  echo "$DEVICE_TOKEN" > "$TOKEN_FILE"
  chmod 600 "$TOKEN_FILE"
  echo "$LOG Provisioned as $DEVICE_ID"
else
  DEVICE_TOKEN=$(cat "$TOKEN_FILE")
  echo "$LOG Using existing device token"
fi

# ── Resolve + register LAN IP (host networking → real LAN IP) ─────────────────
LOCAL_IP=$(ip -4 route get 1.1.1.1 2>/dev/null \
  | awk '{for(i=1;i<=NF;i++) if($i=="src") print $(i+1); exit}')
echo "$LOG Local IP: ${LOCAL_IP:-<unknown>}"

REGISTER_RESPONSE=$(curl -sf -X POST "$DNS_SERVICE_URL/api/register" \
  -H "Authorization: Bearer $DEVICE_TOKEN" -H "Content-Type: application/json" \
  -d "{\"localIp\": \"$LOCAL_IP\"}" 2>/dev/null || true)
DEVICE_FQDN=$(echo "$REGISTER_RESPONSE" \
  | python3 -c "import sys,json; print(json.load(sys.stdin).get('subdomain',''))" 2>/dev/null || true)
if [[ -n "$DEVICE_FQDN" ]]; then
  echo "$LOG Registered: https://$DEVICE_FQDN:$PORT"
  echo "$DEVICE_FQDN" > "$FQDN_FILE"
else
  echo "$LOG WARNING: DNS registration failed — starting without FQDN"
  DEVICE_FQDN=""
fi

# ── Fetch cert if missing or expiring within 30 days ─────────────────────────
FETCH_CERT=false
if [[ ! -f "$CERT_FILE" || ! -f "$KEY_FILE" ]]; then
  FETCH_CERT=true; echo "$LOG Certificate missing, fetching..."
elif ! openssl x509 -checkend 2592000 -noout -in "$CERT_FILE" 2>/dev/null; then
  FETCH_CERT=true; echo "$LOG Certificate expiring within 30 days, refreshing..."
fi
if [[ "$FETCH_CERT" == "true" ]]; then
  CERT_JSON=$(curl -sf "$DNS_SERVICE_URL/api/cert" -H "Authorization: Bearer $DEVICE_TOKEN")
  [[ -n "$CERT_JSON" ]] || { echo "$LOG ERROR: failed to fetch certificate"; exit 1; }
  # Pass the JSON via env (not stdin) so it doesn't collide with the -c script.
  CERT_JSON="$CERT_JSON" CERT_FILE="$CERT_FILE" KEY_FILE="$KEY_FILE" python3 -c '
import os, json
d = json.loads(os.environ["CERT_JSON"])
open(os.environ["CERT_FILE"], "w").write(d["cert"])
open(os.environ["KEY_FILE"], "w").write(d["key"])
print("[erpnet-entrypoint] Certificate saved, expires " + str(d.get("expiresAt", "?")))
'
  chmod 600 "$KEY_FILE"
fi

# ── Start ErpNet.FP.js with TLS ───────────────────────────────────────────────
echo "$LOG Starting ErpNet.FP.js on https://${DEVICE_FQDN:-0.0.0.0}:$PORT"
export DEVICE_ID DEVICE_FQDN PORT
export SSL_CERT_FILE="$CERT_FILE" SSL_KEY_FILE="$KEY_FILE"
exec node src/index.js
