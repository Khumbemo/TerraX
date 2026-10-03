# TerraX production image: builds the app and serves it with the /api proxy.
# Build:  docker build -t terrax .
# Run:    docker run -p 3001:3001 -e GEMINI_API_KEY=... terrax
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production PORT=3001
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY server ./server
COPY src/lib/gemini-core.ts src/lib/gemini-shared.ts ./src/lib/
EXPOSE 3001
USER node
CMD ["npx", "tsx", "server/index.ts"]
