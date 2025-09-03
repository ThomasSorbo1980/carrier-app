FROM node:20-bullseye

# Install build tools (needed for better-sqlite3)
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies first
COPY package*.json ./
RUN npm install --omit=dev

# Copy all files from repo root into the container
COPY . .

ENV PORT=3000
ENV SQLITE_DB_PATH=/data/shipments.db

EXPOSE 3000
CMD ["node","dragdrop-pdf-carrier-instruction-app.js"]
