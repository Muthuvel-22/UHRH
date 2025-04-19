# Use Node.js LTS base image
FROM node:18-alpine

# Set working directory
WORKDIR /usr/src/app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm install --production

# Copy backend source
COPY . .

# Set environment variable
ENV NODE_ENV=production

# Expose the backend port
EXPOSE 15200

# Start the server
CMD ["node", "server.js"]
