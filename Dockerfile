# --- Stage 1: Build Frontend ---
FROM node:22-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .
RUN npm run build

# --- Stage 2: Production Server ---
FROM node:22-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=1945

# Install util-linux for lsblk support inside container
RUN apk add --no-cache util-linux

COPY package*.json ./
RUN npm install --omit=dev && npm install -g tsx

COPY --from=builder /app/dist ./dist
COPY server ./server

EXPOSE 1945

CMD ["npx", "tsx", "server/index.ts"]
