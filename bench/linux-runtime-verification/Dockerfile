FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
ENV PATH="/root/.bun/bin:${PATH}"

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl unzip ca-certificates \
    && curl -fsSL https://bun.sh/install | bash \
    && apt-get purge -y procps \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/* \
    && test ! -e /usr/bin/ps \
    && ! command -v ps

WORKDIR /opt/flywheel-harness
COPY bench/linux-runtime-verification/smoke.ts /opt/flywheel-harness/bench/linux-runtime-verification/smoke.ts

CMD ["sleep", "infinity"]
