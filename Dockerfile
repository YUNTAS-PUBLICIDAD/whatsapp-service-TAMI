FROM node:22-alpine

WORKDIR /app
RUN apk update && apk add git
COPY package*.json ./
RUN npm install --production

COPY . .

# Expone el puerto definido en .env o por defecto 5111
EXPOSE 5111

CMD ["node", "index.js"]