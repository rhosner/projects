FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8080 DB_PATH=/data/cribbage.db
COPY package.json ./
COPY src ./src
COPY public ./public
EXPOSE 8080
CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.js"]
