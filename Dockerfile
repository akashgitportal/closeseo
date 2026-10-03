FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY public ./public
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3001 DATABASE_PATH=/data/closeseo.db AUTH_MODE=api_key
# The data directory must belong to the unprivileged user before it becomes a volume (named volumes copy this ownership).
RUN mkdir -p /data && chown node:node /data
VOLUME /data
EXPOSE 3001
USER node
CMD ["node", "src/server.ts"]
