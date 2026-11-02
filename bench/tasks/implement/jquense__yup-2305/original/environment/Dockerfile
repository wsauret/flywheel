FROM ubuntu:24.04

# Base system packages (common to all languages)
RUN apt-get update && apt-get install -y \
    git \
    curl \
    ca-certificates \
    patch \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js 22 (from .nvmrc)
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && \
    apt-get install -y nodejs && \
    rm -rf /var/lib/apt/lists/*

# Enable corepack for Yarn 4.5.3
RUN corepack enable

WORKDIR /app

# Clone repo at HEAD commit (with fix applied)
RUN git clone https://github.com/jquense/yup.git src && \
    cd src && \
    (git fetch --depth 1 origin fe5a10bef3326d1e241b5ee75c98d8e1eb051660 || git fetch --depth 1 origin "+refs/pull/2305/head:refs/remotes/origin/pr/2305") && \
    git checkout --detach FETCH_HEAD && \
    git submodule update --init --recursive

WORKDIR /app/src

# Install dependencies with Yarn
RUN yarn install --frozen-lockfile

# Build TypeScript project
RUN yarn build

# If install/build steps touched tracked files (lockfiles, generated assets),
# reset them so bug.patch applies cleanly.
RUN git reset --hard

# Apply bug.patch to revert to buggy state (BASE)
COPY bug.patch /tmp/bug.patch
RUN patch -p1 < /tmp/bug.patch && rm /tmp/bug.patch

# Rebuild TypeScript after applying bug.patch
RUN yarn build

RUN rm -rf /app/src/.git

WORKDIR /app/src