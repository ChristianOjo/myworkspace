# Stage 1: Build web app
FROM node:24-slim AS web
WORKDIR /web
COPY web/package*.json ./
RUN npm ci
COPY web/ ./
RUN VITE_API_BASE_URL= npm run build

# Stage 2: Build backend
FROM node:24-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY src/ ./src/
COPY scripts/ ./scripts/
COPY tsconfig*.json ./
RUN npm run build

# Stage 3: Runtime
FROM node:24-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY migrations/ ./migrations/
COPY --from=web /web/dist ./public
ENV STATIC_DIR=/app/public
ENV HOST=0.0.0.0
ENV PORT=3000
USER node
EXPOSE 3000
   HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
     CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
	 CMD ["node", "dist/src/http/server.js"]