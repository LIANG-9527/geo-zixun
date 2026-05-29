FROM node:22-alpine

WORKDIR /app
COPY package.json ./
RUN npm install --production
COPY . .

ENV PORT=3000
ENV NODE_TLS_REJECT_UNAUTHORIZED=0

EXPOSE 3000

CMD ["node", "server.js"]
