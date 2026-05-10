FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY . .
RUN mkdir -p /data
EXPOSE 9090
ENV PORT=9090
CMD ["node", "src/index.js"]
