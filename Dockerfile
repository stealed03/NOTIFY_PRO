FROM node:20-alpine

# Install required system deps
RUN apk add --no-cache \
    git \
    python3 \
    make \
    g++ \
    cairo-dev \
    pango-dev \
    jpeg-dev \
    giflib-dev \
    librsvg-dev

WORKDIR /app

# Copy package files
COPY package*.json ./

RUN npm install --production

# Copy source
COPY . .

# Create directories
RUN mkdir -p \
    data/users \
    data/sessions \
    data/whatsapp \
    data/logs \
    data/backups \
    config

# Non-root user
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

RUN chown -R appuser:appgroup /app

USER appuser

EXPOSE 3000

CMD ["node", "src/index.js"]
