# Deterministic alternative to the Nixpacks build in railway.json.
FROM node:22-slim AS build

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json drizzle.config.ts ./
COPY src ./src
RUN npm run build

FROM node:22-slim AS runtime

ENV NODE_ENV=production

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY drizzle ./drizzle

# Run as an unprivileged user rather than root.
USER node

EXPOSE 8080

CMD ["node", "dist/index.js"]
