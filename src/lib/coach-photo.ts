/**
 * Coach photo storage helpers (Vercel Blob).
 *
 * Photos uploaded by Harley via Telegram land at `coach/<timestamp>.<ext>`.
 * The dashboard reads the most-recent one each render. Falls back to the
 * static `/coach.jpg` shipped in `public/` when Blob isn't provisioned or
 * Harley hasn't uploaded yet.
 */
import { list, put } from "@vercel/blob";

const COACH_BLOB_PREFIX = "coach/";

export const COACH_PHOTO_FALLBACK = "/coach.jpg";

/**
 * Returns the URL of the most-recently-uploaded coach photo, or null if
 * Blob is unconfigured / empty / errored. Caller should fall back to
 * `COACH_PHOTO_FALLBACK`.
 */
export async function getLatestCoachPhotoUrl(): Promise<string | null> {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return null;
  try {
    const { blobs } = await list({ prefix: COACH_BLOB_PREFIX, limit: 100 });
    if (blobs.length === 0) return null;
    const latest = blobs.reduce((a, b) =>
      a.uploadedAt > b.uploadedAt ? a : b
    );
    return latest.url;
  } catch (e) {
    console.error("[coach-photo] list failed:", (e as Error).message);
    return null;
  }
}

/**
 * Uploads coach photo bytes to a timestamped path and returns the public URL.
 * Throws on failure — caller decides whether to log + swallow.
 */
export async function uploadCoachPhoto(
  bytes: ArrayBuffer,
  ext: string
): Promise<string> {
  const safeExt = /^[a-z0-9]{2,4}$/i.test(ext) ? ext.toLowerCase() : "jpg";
  const pathname = `${COACH_BLOB_PREFIX}${Date.now()}.${safeExt}`;
  const { url } = await put(pathname, Buffer.from(bytes), {
    access: "public",
    contentType: `image/${safeExt === "jpg" ? "jpeg" : safeExt}`,
    addRandomSuffix: false,
  });
  return url;
}
