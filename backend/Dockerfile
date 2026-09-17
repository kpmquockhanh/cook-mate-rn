# Backend image: the crawl/enrich/publish pipeline, its operator console, and
# the app-facing API. All three run from this one image (see docker-compose.yml
# at the repo root for which command each service uses) because they share
# every file under src/ and deploy as one package (see README.md).
#
# The project runs TypeScript directly via tsx rather than a compiled `dist/`,
# so this image does the same instead of adding a build step the rest of the
# repo doesn't have.
FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# 8787 = API (src/api), 5174 = pipeline console (src/ui). A given container
# only serves one of these; both are exposed so either command works without
# editing the image.
EXPOSE 8787 5174

CMD ["npm", "run", "api"]
