# Use Node 18
FROM node:18-slim

# Install system dependencies needed for pdf/image/ocr tools
RUN apt-get update && apt-get install -y \
    poppler-utils \
    tesseract-ocr \
    imagemagick \
    build-essential \
    sqlite3 \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy package.json (and lockfile if present)
COPY package.json package-lock.json* ./

# Install dependencies
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi

# Copy rest of the project
COPY . .

# Expose port
EXPOSE 3000

# Start app
CMD ["npm", "start"]
