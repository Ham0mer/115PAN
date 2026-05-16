FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json ./
RUN npm install --production=false
COPY src/ ./src/
COPY public/ ./public/
COPY config/ ./config/

FROM node:20-alpine
RUN apk add --no-cache ffmpeg curl
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/src ./src
COPY --from=builder /app/public ./public
COPY --from=builder /app/config ./config
COPY package.json ./
RUN mkdir -p /app/data/thumbnails /app/logs
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fs http://localhost:3000/api/health || exit 1
CMD ["node", "src/server.js"]
