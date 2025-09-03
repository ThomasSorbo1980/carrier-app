FROM node:20-slim

# System deps for extraction
RUN apt-get update && apt-get install -y --no-install-recommends \
    poppler-utils \            # pdftotext, pdftoppm
    tesseract-ocr \
    tesseract-ocr-eng \
    imagemagick \              # 'convert' for deskew/denoise
 && rm -rf /var/lib/apt/lists/*

# App setup
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .

ENV NODE_ENV=production PORT=3000
EXPOSE 3000
CMD ["node", "dragdrop-pdf-carrier-instruction-app.js"]
