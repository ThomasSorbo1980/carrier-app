FROM node:20-bullseye

# Tools needed to compile better-sqlite3
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps first (better layer caching)
COPY package*.json ./
# Try npm ci if you have a lockfile; fall back to npm install if not
RUN npm ci --omit=dev || npm install --omit=dev

# Copy the rest (your JS file must be here)
COPY . .

ENV PORT=3000
# IMPORTANT: your app should read SQLITE_DB_PATH
ENV SQLITE_DB_PATH=/data/shipments.db

EXPOSE 3000
CMD ["node","dragdrop-pdf-carrier-instruction-app.js"]
