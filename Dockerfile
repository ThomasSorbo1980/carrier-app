# ---- Base image ----
FROM node:18-slim

# ---- System packages for PDF/OCR ----
RUN apt-get update && apt-get install -y --no-install-recommends \
    poppler-utils imagemagick tesseract-ocr tesseract-ocr-eng tesseract-ocr-deu \
    build-essential python3 \
 && rm -rf /var/lib/apt/lists/*

# ---- App dir ----
WORKDIR /app

# ---- Install deps (no lockfile required) ----
# Copy only manifests first to leverage Docker layer caching
COPY package*.json ./
# If a lockfile exists it will be used; otherwise a normal install runs.
# Using npm install avoids the "npm ci requires a lockfile" error.
RUN npm install --omit=dev

# ---- Copy the rest ----
COPY . .

ENV NODE_ENV=production
EXPOSE 3000

# Start: expects "start": "node dragdrop-pdf-carrier-instruction-app.js" in package.json
CMD ["npm", "start"]
