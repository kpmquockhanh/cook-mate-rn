# Voice agent worker. It connects out to LiveKit Cloud rather than serving
# inbound traffic; AGENT_PORT is only its own health-check endpoint.
# Must be glibc-based (not alpine/musl): @livekit/rtc-ffi-bindings only
# publishes native binaries for linux-*-gnu, not linux-*-musl.
FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

EXPOSE 8082

CMD ["npm", "run", "start"]
