FROM node:20-alpine

# Install required system deps (for Baileys/sharp)
RUN apk add --no-cache \
    python3 \
    make \
    g++ \
    cairo-dev \
    pango-dev \
    jpeg-dev \
    giflib-dev \
    librsvg-dev

WORKDIR /app

# Copy package files first (layer caching)
COPY package*.json ./
RUN npm install --production

# Copy source
COPY . .

# Create data directories
RUN mkdir -p data/users data/sessions data/whatsapp data/logs data/backups config

# Non-root user for security
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
RUN chown -R appuser:appgroup /app
USER appuser

EXPOSE 3000

CMD ["node", "src/index.js"]
