# ---- Base image ----
FROM node:18-slim

# ---- System packages for PDF/OCR and (fallback) native builds ----
# - poppler-utils: pdftotext, pdftoppm
# - imagemagick: convert
# - tesseract-ocr (+ eng/deu langs)
# - build-essential, python3: only used if a native module needs to compile
RUN apt-get update && apt-get install -y --no-install-recommends \
    poppler-utils imagemagick tesseract-ocr tesseract-ocr-eng tesseract-ocr-deu \
    build-essential python3 \
 && rm -rf /var/lib/apt/lists/*

# ---- App directory ----
WORKDIR /app

# ---- Install Node deps (cached layer) ----
# If you have a package-lock.json, copy it too so `npm ci` can use it.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# ---- Copy the rest of the app ----
COPY . .

# ---- Environment ----
ENV NODE_ENV=production

# Render will set PORT; your app already uses process.env.PORT
EXPOSE 3000

# ---- Start the server ----
# This expects: "start": "node dragdrop-pdf-carrier-instruction-app.js" in package.json
CMD ["npm", "start"]
