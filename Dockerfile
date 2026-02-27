FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ src/
RUN npx tsc

FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist/ dist/
ENV NODE_ENV=production
EXPOSE 3000
RUN adduser --disabled-password --gecos "" --uid 1001 tokensafe
USER 1001
CMD ["node", "dist/index.js"]
