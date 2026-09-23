import { LOOPBACK_HOSTS, RELEASES_PER_PAGE } from "../constants.js";
export function pointsAtThisMachine(override) {
    try {
        return LOOPBACK_HOSTS.has(new URL(override).hostname);
    }
    catch {
        return false;
    }
}
export function taggedReleaseUrl(releasesApi, tag) {
    const url = new URL(releasesApi);
    url.search = "";
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/tags/${encodeURIComponent(tag)}`;
    return url.href;
}
export function listedReleasesUrl(releasesApi) {
    const url = new URL(releasesApi);
    url.searchParams.set("per_page", String(RELEASES_PER_PAGE));
    return url.href;
}
//# sourceMappingURL=http.js.map