# --- deps: install all dependencies (including devDependencies) ---
FROM node:22-alpine AS deps

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# --- build: compile TypeScript ---
FROM deps AS build

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# --- production: minimal runtime image ---
FROM node:22-alpine AS production

WORKDIR /app

RUN addgroup -S appgroup && adduser -S appuser -G appgroup

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist/ ./dist/

USER appuser

EXPOSE 3456

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:${API_PORT:-3456}/health || exit 1

CMD ["node", "dist/index.js"]
