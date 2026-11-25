FROM node:22-slim

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm install --legacy-peer-deps

# Copy application source and assets
COPY . .

# Expose standard port
ENV PORT=3001
ENV NODE_ENV=production
EXPOSE 3001

# Start the Fastify server
CMD ["npm", "start"]
