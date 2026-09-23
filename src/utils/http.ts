import { LOOPBACK_HOSTS, RELEASES_PER_PAGE } from "../constants.js";

export function pointsAtThisMachine(override: string): boolean {
  try {
    return LOOPBACK_HOSTS.has(new URL(override).hostname);
  } catch {
    return false;
  }
}

export function taggedReleaseUrl(releasesApi: string, tag: string): string {
  const url = new URL(releasesApi);
  url.search = "";
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/tags/${encodeURIComponent(tag)}`;
  return url.href;
}

export function listedReleasesUrl(releasesApi: string): string {
  const url = new URL(releasesApi);
  url.searchParams.set("per_page", String(RELEASES_PER_PAGE));
  return url.href;
}
