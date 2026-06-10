# Donna — single image for API server, worker, and built web UI.
# Run the API:    docker run donna
# Run the worker: docker run donna pnpm --filter @donna/server worker
FROM node:22-bookworm-slim AS build
RUN corepack enable
WORKDIR /app

# Install dependencies with a warm cache layer
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/llm/package.json packages/llm/
COPY packages/connectors/package.json packages/connectors/
RUN pnpm install --frozen-lockfile

# Build the web bundle
COPY . .
RUN pnpm --filter @donna/web build

FROM node:22-bookworm-slim AS runner
RUN corepack enable
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app /app

ENV DONNA_PORT=3001 \
    DONNA_HOST=0.0.0.0 \
    DONNA_DATA_DIR=/data \
    DONNA_PUBLIC_DIR=/app/apps/web/dist
VOLUME /data
EXPOSE 3001

CMD ["pnpm", "--filter", "@donna/server", "start"]
