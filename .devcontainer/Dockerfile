FROM mcr.microsoft.com/devcontainers/javascript-node:1-22-bookworm

ARG PNPM_VERSION=10.11.1

RUN corepack enable \
  && corepack prepare "pnpm@${PNPM_VERSION}" --activate

USER node
