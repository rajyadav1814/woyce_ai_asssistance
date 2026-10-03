import { ImageAttachment } from '../providers/types';

export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
export const MAX_IMAGES = 4;
/** Anthropic's per-image limit is the strictest of the supported providers. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** Validates images arriving from the webview; drops anything malformed, oversized or of an unsupported type. */
export function sanitizeImages(input: unknown): ImageAttachment[] {
  if (!Array.isArray(input)) {
    return [];
  }
  const out: ImageAttachment[] = [];
  for (const item of input) {
    const { mimeType, data } = (item ?? {}) as Partial<ImageAttachment>;
    if (
      typeof mimeType === 'string' &&
      IMAGE_TYPES.includes(mimeType) &&
      typeof data === 'string' &&
      data.length > 0 &&
      (data.length * 3) / 4 <= MAX_IMAGE_BYTES &&
      BASE64.test(data)
    ) {
      out.push({ mimeType, data });
    }
    if (out.length === MAX_IMAGES) {
      break;
    }
  }
  return out;
}

export function mimeFromPath(path: string): string | undefined {
  const ext = path.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  return { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }[ext ?? ''];
}
