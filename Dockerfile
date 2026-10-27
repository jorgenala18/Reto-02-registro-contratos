FROM oven/bun:1.1-alpine
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --production
COPY . .
ENV PORT=3000
EXPOSE 3000
CMD ["bun", "src/server.ts"]
