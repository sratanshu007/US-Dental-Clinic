FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json drizzle.config.ts ./
COPY src ./src
COPY drizzle ./drizzle
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev && npm i drizzle-kit --no-save
COPY --from=build /app/dist ./dist
COPY drizzle ./drizzle
COPY drizzle.config.ts ./
EXPOSE 4000
# apply migrations, then start
CMD ["sh", "-c", "npx drizzle-kit migrate && node dist/seed.js && node dist/server.js"]
