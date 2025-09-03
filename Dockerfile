FROM node:20-bullseye

# build tools for better-sqlite3
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# install deps
COPY package*.json ./
RUN npm install --omit=dev

# copy app
COPY . .

# don't set PORT here; Render sets it
# ENV PORT=3000   <-- REMOVE this line

# optional; harmless
EXPOSE 3000

# app will read process.env.PORT from Render
CMD ["node","dragdrop-pdf-carrier-instruction-app.js"]
