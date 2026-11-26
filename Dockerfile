# Image épinglée par empreinte (politique MINITEL : jamais de tag flottant)
FROM node:22-alpine@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a

WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    DATA_DIR=/data \
    TRUST_PROXY=true

COPY package.json ./
COPY server ./server
COPY public ./public

RUN mkdir -p /data/snapshots && chown -R node:node /app /data

USER node

# Écoute HTTP interne uniquement (TLS terminé par Caddy sur Sakura, routé via coolify-proxy:80 sur Isadora)
# Ne jamais utiliser 8080 (réservé au contrôleur UniFi sur Isadora)
EXPOSE 3000

VOLUME ["/data"]

HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]
