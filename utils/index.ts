import { env } from '../lib/env';

export const getImageUrl = (image: string) => {
  if (!image) {
    return '';
  }

  // Crawled recipes carry the source site's absolute image URL, while
  // self-hosted images are stored as paths relative to the storage bucket.
  // Prefixing an absolute URL produced STORAGE_URL/https://othersite.com/x.jpg,
  // which resolves to nothing.
  if (/^https?:\/\//i.test(image)) {
    return image;
  }

  return `${env.storageUrl}/${image.replace(/^\//, '')}`;
};
