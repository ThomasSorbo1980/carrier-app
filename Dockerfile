FROM node:20-bullseye
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY dragdrop-pdf-carrier-instruction-app.js ./
ENV PORT=3000
EXPOSE 3000
CMD ["node","dragdrop-pdf-carrier-instruction-app.js"]
