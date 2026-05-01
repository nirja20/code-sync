# Use official Node.js LTS on Debian Bullseye
FROM node:20-bullseye

# Install all language runtimes/compilers needed by the code editor
RUN apt-get update && apt-get install -y \
    default-jdk \
    gcc \
    g++ \
    python3 \
    python3-pip \
    && ln -sf /usr/bin/python3 /usr/bin/python \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Install dependencies first (better Docker cache layer)
COPY package*.json ./
RUN npm install

# Copy the rest of the source code
COPY . .

# Build the React frontend
RUN npm run build

# Expose the port the server listens on
EXPOSE 5000

# Start the Node.js server
CMD ["node", "server.js"]
