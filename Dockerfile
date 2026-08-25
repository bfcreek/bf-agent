FROM node:20-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git bash python3 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
COPY src ./src
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN sed -i 's/\r$//' /docker-entrypoint.sh && chmod +x /docker-entrypoint.sh

WORKDIR /workspace
VOLUME ["/workspace"]

ENV HALO_PORT=11435 \
    HALO_MODEL=auto \
    HALO_OLLAMA_URL=http://ollama:11434 \
    HALO_CWD=/workspace \
    HALO_NUM_CTX=16384

EXPOSE 11435

ENTRYPOINT ["/docker-entrypoint.sh"]
CMD ["serve"]
