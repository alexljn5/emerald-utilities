# src/bots/infbot-src/Dockerfile
FROM node:20-alpine

# Set working directory
WORKDIR /app

# Copy only package files first to install deps
COPY package*.json ./

RUN npm install --production

# Copy the rest of the code
COPY . ./

# Start the bot with nodemon
CMD ["npx", "nodemon", "bot-entry.js"]
