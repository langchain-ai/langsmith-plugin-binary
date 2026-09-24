import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineBinaryTarget } from "./binary.js";
import type { HostOptions, PluginBinary } from "./models.js";

export const CODEX: PluginBinary = defineBinaryTarget({
  executableName: "langsmith-codex-tracing",
  repository: "langchain-ai/langsmith-codex-plugins",
  userAgent: "langsmith-codex",
  releasesApiOverrideEnvVar: "LANGSMITH_CODEX_RELEASES_API",
});

export const RELEASES_API =
  "https://api.github.com/repos/langchain-ai/langsmith-codex-plugins/releases";
export const DOWNLOAD_PREFIX =
  "https://github.com/langchain-ai/langsmith-codex-plugins/releases/download/";

export interface PublishedRelease {
  json: Record<string, unknown>;
  files: Record<string, string>;
}

export interface PublishOptions {
  prerelease?: boolean;
  draft?: boolean;
  arch?: string;
  body?: string;
  digest?: string | null;
  checksum?: string;
}

export function scratchDirectory(): string {
  return mkdtempSync(join(tmpdir(), "plugin-binary-"));
}

export function sha256(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}

export function executableBody(version: string): string {
  return `#!/bin/sh\n[ "$1" = "--version" ] && echo ${version}\nexit 0\n`;
}

export function publish(version: string, options: PublishOptions = {}): PublishedRelease {
  const arch = options.arch ?? "arm64";
  const name = `langsmith-codex-tracing-darwin-${arch}-${version}`;
  const body = options.body ?? executableBody(version);
  const url = `${DOWNLOAD_PREFIX}${version}/${name}`;
  const assets: unknown[] = [
    {
      name,
      browser_download_url: url,
      size: Buffer.byteLength(body),
      digest: options.digest === undefined ? `sha256:${sha256(body)}` : options.digest,
    },
  ];
  const files: Record<string, string> = { [url]: body };

  if (options.checksum !== undefined) {
    const checksumUrl = `${url}.sha256`;
    assets.push({
      name: `${name}.sha256`,
      browser_download_url: checksumUrl,
      size: Buffer.byteLength(options.checksum),
      digest: null,
    });
    files[checksumUrl] = options.checksum;
  }

  return {
    json: {
      tag_name: version,
      draft: options.draft ?? false,
      prerelease: options.prerelease ?? false,
      assets,
    },
    files,
  };
}

export function serve(releases: PublishedRelease[], tagged = releases[0]): typeof fetch {
  const files = Object.assign({}, ...releases.map((release) => release.files)) as Record<
    string,
    string
  >;
  return (async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    if (url.startsWith(`${RELEASES_API}?`)) {
      return new Response(JSON.stringify(releases.map((release) => release.json)), { status: 200 });
    }
    if (url.startsWith(`${RELEASES_API}/tags/`)) {
      if (!tagged) return new Response("not found", { status: 404 });
      return new Response(JSON.stringify(tagged.json), { status: 200 });
    }
    const body = files[url];
    if (body === undefined) return new Response("not found", { status: 404 });
    return new Response(body, { status: 200 });
  }) as typeof fetch;
}

export function recordRequests(urls: string[]): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0]) => {
    urls.push(String(input));
    return new Response("[]", { status: 200 });
  }) as typeof fetch;
}

export function acceptEverything(): HostOptions {
  return {
    runtimePlatform: "darwin",
    runtimeArch: "arm64",
    verifySignature: async () => {},
    pause: async () => {},
  };
}

export function recordedPauses(): { waits: number[]; pause: (ms: number) => Promise<void> } {
  const waits: number[] = [];
  return {
    waits,
    pause: async (ms: number) => {
      waits.push(ms);
    },
  };
}
