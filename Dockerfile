FROM node:18-alpine

WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production || npm i --only=production
COPY src ./src
COPY data ./data
ENV PORT=3000
EXPOSE 3000
CMD ["node", "src/server.js"]
