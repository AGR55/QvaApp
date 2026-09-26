FROM node:24-bookworm-slim

LABEL qvaapply.release="true"

ENV NODE_ENV=production
ENV PNPM_HOME=/pnpm
ENV PATH=/pnpm:$PATH

RUN corepack enable

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile --ignore-scripts

COPY dist ./dist
COPY public ./public

USER node

EXPOSE 3000

CMD ["node", "--enable-source-maps", "dist/index.js"]
