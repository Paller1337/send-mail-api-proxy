FROM node:18-alpine

WORKDIR /app

ENV NODE_ENV=production \
    PORT=8080

COPY package*.json ./
RUN apk add --no-cache ca-certificates \
    && npm ci --omit=dev

COPY src ./src

EXPOSE 8080

CMD ["node","src/index.js"]
