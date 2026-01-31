FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

RUN mkdir -p /app/logs /app/auth_info && \
    chmod -R 777 /app/auth_info

VOLUME ["/app/auth_info", "/app/logs"]

EXPOSE 3001

CMD ["node", "server.js"]