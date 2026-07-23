# ErpNet.FP.js — fiscal print service
# Debian-based node (buildpack-deps) so the serialport native module compiles.
FROM node:20-bookworm

LABEL maintainer="TeamCore, Ltd. <info@plana.solutions>"

# Tools used by the entrypoint (provision/register/cert-fetch, LAN-IP detection).
RUN apt-get update && apt-get install -y --no-install-recommends \
      curl openssl python3 iproute2 ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install prod deps first for layer caching.
COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

# The durable УНП / invoice counter state MUST live on a mounted volume, never
# in the image layer, or a restart/redeploy would wipe it — tripping the
# fail-closed guard (and risking duplicate numbers). Point it at /data.
ENV USN_STATE_PATH=/data/usn-state.json
VOLUME ["/data"]

# TLS is optional: if SSL_CERT_FILE/SSL_KEY_FILE point at a mounted cert the
# service serves HTTPS, otherwise plain HTTP. Cert files are mounted, not baked.
EXPOSE 8001

# Entrypoint provisions/registers/fetches the wildcard cert, then starts the app
# with TLS. Requires DNS_SERVICE_URL + INSTALL_TOKEN (see docker-compose.yml).
ENTRYPOINT ["bash", "docker-entrypoint.sh"]
