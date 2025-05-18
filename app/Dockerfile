# -------- Stage 1: Build --------
FROM node:18-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY tsconfig.json jest.config.ts ./
COPY eslint.config.mjs .eslintignore ./

COPY src ./src

RUN npm run test

RUN npm run build

# -------- Stage 2: Run --------
FROM node:18-alpine AS runner

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY --from=builder /app/dist ./dist

CMD ["node", "dist/index.js"]
