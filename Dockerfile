FROM node:20-bullseye
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY dragdrop-pdf-carrier-instruction-app.js ./
ENV PORT=3000
EXPOSE 3000
CMD ["node","dragdrop-pdf-carrier-instruction-app.js"]
