export const getImageUrl = (image: string) => {
  if (!image) {
    return '';
  }

  const apiBase = process.env.EXPO_PUBLIC_STORAGE_URL;
  if (!apiBase) {
    throw new Error('Missing EXPO_PUBLIC_STORAGE_URL');
  }

  const url = `${apiBase}/${image}`;  
  return url;
};