# --- Base image ---
FROM node:20-slim

# --- Install system dependencies ---
# better-sqlite3 needs build tools, and we need pdf/ocr tools
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 g++ make \
    poppler-utils \
    tesseract-ocr \
    imagemagick \
 && rm -rf /var/lib/apt/lists/*

# --- Set working directory ---
WORKDIR /app

# --- Install deps ---
# Copy only package.json + lock first (better caching)
COPY package.json package-lock.json* ./

# Install production deps (no dev)
RUN npm ci --only=production

# --- Copy the rest of the app ---
COPY . .

# --- Expose port ---
EXPOSE 3000

# --- Start command ---
CMD ["node", "server.js"]
