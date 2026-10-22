# Node runtime packaging only (no second runtime, no database).
# Build stage compiles the shared core + UI; runtime stage keeps production
# dependencies and the compiled Node server + static UI.
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:24-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist/node ./dist/node
COPY --from=build /app/package.json ./package.json
USER node
EXPOSE 8787
ENV PORT=8787
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/node/server.mjs"]
