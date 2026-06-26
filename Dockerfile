FROM node:18-alpine
WORKDIR /app
COPY package.json .
COPY index.js .
ENV NODE_ENV=production
ENV POLL_INTERVAL_MS=15000
EXPOSE 3000
CMD ["node", "index.js"]
