# No dependencies at runtime and no build step: Node runs the TypeScript directly.
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8080 CONFIG_FILE=/config/apps.json BUILDS_ROOT=/srv/builds
COPY package.json ./
COPY src ./src
COPY public ./public
USER node
EXPOSE 8080
HEALTHCHECK --interval=60s --timeout=5s CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
CMD ["node", "src/server.ts"]
