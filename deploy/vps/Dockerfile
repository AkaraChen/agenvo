FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY src ./src
COPY scripts/build.mjs ./scripts/build.mjs
COPY wrangler.jsonc ./
RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY package.json LICENSE NOTICE ./
USER node
EXPOSE 8080
ENTRYPOINT ["node", "dist/cli.js"]
CMD ["relay", "serve", "--config", "/config/relay.json"]
