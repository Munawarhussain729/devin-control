FROM node:20-alpine
WORKDIR /app
COPY package.json server.js ./
COPY public ./public
ENV NODE_ENV=production PORT=8787 TRUST_PROXY=1 DATA_DIR=/app/data
RUN mkdir -p /app/data && chown node:node /app/data
EXPOSE 8787
USER node
CMD ["node", "server.js"]
