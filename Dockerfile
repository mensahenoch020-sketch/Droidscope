FROM node:24-alpine
WORKDIR /app
COPY package.json ./
COPY server ./server
COPY web ./web
ENV NODE_ENV=production
ENV DROIDSCOPE_STORAGE_ROOT=/data
RUN mkdir -p /data
EXPOSE 3000
CMD ["node", "server/server.js"]
