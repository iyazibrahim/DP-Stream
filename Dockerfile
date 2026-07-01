FROM node:22-bookworm-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    ca-certificates \
    libva2 \
    libva-drm2 \
    intel-media-va-driver \
    vainfo \
 && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

ENV DB_HOST=db
ENV DB_PORT=3306

EXPOSE 3000
CMD ["npm", "start"]
