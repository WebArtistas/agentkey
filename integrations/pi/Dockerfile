FROM node:26.13.0-bookworm-slim@sha256:add5c17c14752c54d2f3d519ec46a3815684d41c33f198bcb09fb998f7dcbf68
WORKDIR /app
RUN npm install --global pnpm@12.16.1
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY integrations/pi/package.json ./integrations/pi/package.json
RUN pnpm install --prod --frozen-lockfile
COPY dist/agent/ ./dist/agent/
COPY dist/core/schema.js dist/core/database-schema.js ./dist/core/
COPY integrations/pi/runner.mjs integrations/pi/relay.mjs integrations/pi/probe.mjs ./integrations/pi/
COPY skills/agentkey/SKILL.md ./skills/agentkey/SKILL.md
ENV NODE_ENV=production
LABEL org.opencontainers.image.source="https://github.com/WebArtistas/agentkey"
USER node
CMD ["node", "/app/integrations/pi/runner.mjs"]
