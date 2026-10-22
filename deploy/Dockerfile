FROM node:24.22.1-bookworm-slim AS qvaapply-runtime

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

CMD ["sh", "-c", "umask 077 && exec node --enable-source-maps dist/index.js"]
