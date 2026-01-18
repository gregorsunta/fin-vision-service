# ---- Base ----
# Official Node.js 22 image as a base
FROM node:22-alpine AS base
WORKDIR /app
RUN apk --no-cache add dumb-init
COPY package.json npm-lock.yaml* ./

# ---- Dependencies ----
# Install production dependencies
FROM base AS deps
RUN npm install --omit=dev

# ---- Build ----
# Build the TypeScript project
FROM base AS build
RUN npm install
COPY . .
RUN npm run build

# ---- Development ----
# Image for local development with all dependencies and source code
FROM base AS development
ENV NODE_ENV=development
RUN npm install
COPY . .

# ---- Production ----
# Final, lightweight image
FROM base AS production
WORKDIR /app
ENV NODE_ENV=production

# Copy necessary files from previous stages
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json .

# Use dumb-init to handle signals properly
ENTRYPOINT ["/usr/bin/dumb-init", "--"]

# Default command can be overridden
CMD ["node", "dist/api/index.js"]
