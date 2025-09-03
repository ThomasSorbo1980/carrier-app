FROM node:20-bullseye

# Build tools + PDF/ OCR utilities
RUN apt-get update && apt-get install -y \
  python3 make g++ \
  poppler-utils \
  tesseract-ocr \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

# Do NOT set PORT; Render provides it
EXPOSE 3000
CMD ["node","dragdrop-pdf-carrier-instruction-app.js"]
