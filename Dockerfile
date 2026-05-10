FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY src/ ./src/
COPY public-site/ ./public-site/
RUN mkdir -p data
EXPOSE 9090
CMD ["node", "src/index.js"]
