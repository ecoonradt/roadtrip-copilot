# Stage 1: Build Fastify TypeScript server
FROM public.ecr.aws/docker/library/node:20-slim AS builder

WORKDIR /app/route-builder

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.server.json ./
COPY server ./server
RUN npm run build:server && npm prune --omit=dev

# Stage 2: Production runtime with AWS Lambda Web Adapter
FROM public.ecr.aws/docker/library/node:20-slim

COPY --from=public.ecr.aws/awsguru/aws-lambda-adapter:0.8.4 /lambda-adapter /opt/extensions/lambda-adapter

ENV NODE_ENV=production
ENV PORT=3001
ENV HOST=0.0.0.0
ENV AWS_LWA_INVOKE_MODE=response_stream
ENV AWS_LWA_READINESS_CHECK_PATH=/api/health

WORKDIR /app/route-builder

COPY package.json ./
COPY --from=builder /app/route-builder/node_modules ./node_modules
COPY --from=builder /app/route-builder/dist-server ./dist-server

EXPOSE 3001

CMD ["node", "dist-server/index.js"]
