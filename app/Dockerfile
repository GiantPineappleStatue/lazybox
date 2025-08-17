# Dev container for TanStack Start app
FROM node:20-alpine

WORKDIR /app

# Install pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

# Install deps (cache layer)
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# Copy source
COPY . .

# Expose Vite dev server
EXPOSE 3000

# Default command
CMD ["pnpm", "dev", "--port", "3000", "--host", "0.0.0.0"]
