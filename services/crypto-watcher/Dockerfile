FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev || true
COPY . .
ENV PORT=8745
EXPOSE 8745
CMD ["node", "index.mjs"]
