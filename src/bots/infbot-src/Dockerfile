# infbot-deploy/Dockerfile
FROM node:20-alpine

# Set working directory
WORKDIR /app

# Copy only package files first to install deps
COPY package*.json ./

RUN npm install --production

# Copy the rest of the code
COPY infbot-src/ ./

# Start the bot with nodemon
CMD ["npx", "nodemon", "infbot-src/bot-entry.js"]
