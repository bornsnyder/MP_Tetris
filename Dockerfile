# MP_Tetris — multi-stage build: client (vite) + server (tsc), single runtime image.
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY tsconfig.base.json tsconfig.server.json shared/ server/ client/ ./
RUN npm run build

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist-server ./dist-server
COPY --from=build /app/dist-client ./dist-client
COPY package.json ./
VOLUME ["/app/data"]
EXPOSE 6000
ENV PORT=6000 DATA_DIR=/app/data
CMD ["node", "dist-server/server/src/index.js"]
