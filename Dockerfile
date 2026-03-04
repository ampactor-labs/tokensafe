FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ src/
RUN npx tsc

# Stage 2: production deps with native module compilation (better-sqlite3)
FROM node:22-slim AS deps
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Stage 3: final slim image
FROM node:22-slim
WORKDIR /app
COPY --from=deps /app/node_modules node_modules/
COPY --from=build /app/dist/ dist/
COPY package.json ./
COPY public/ public/
ENV NODE_ENV=production
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/health').then(r=>{if(!r.ok)process.exit(1)})" || exit 1
RUN mkdir -p /app/data
CMD ["node", "dist/index.js"]
