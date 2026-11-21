FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/desktop/package.json apps/desktop/package.json
RUN npm ci --ignore-scripts
COPY apps/server apps/server
RUN npm run build -w @wiisb/server && npm prune --omit=dev --ignore-scripts
FROM node:24-bookworm-slim
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4310 DATA_DIR=/data
WORKDIR /app
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/apps/server apps/server
COPY package.json ./
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 4310
CMD ["node","apps/server/dist/main.js"]
