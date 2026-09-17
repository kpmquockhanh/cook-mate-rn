# Voice agent worker. It connects out to LiveKit Cloud rather than serving
# inbound traffic; AGENT_PORT is only its own health-check endpoint.
# Must be glibc-based (not alpine/musl): @livekit/rtc-ffi-bindings only
# publishes native binaries for linux-*-gnu, not linux-*-musl.
FROM node:22-slim

# node:*-slim ships no system CA bundle. Node itself carries its own, so plain
# `fetch` works and hides this, but the native LiveKit engine
# (@livekit/rtc-ffi-bindings) validates TLS against the *system* store - without
# it every job dies on "signal failure: failed to retrieve region info".
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

EXPOSE 8082

CMD ["npm", "run", "start"]
