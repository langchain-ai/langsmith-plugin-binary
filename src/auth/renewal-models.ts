export interface LoginNotify {
  plugin: string;
  cooldown?: number | "off" | undefined;
}

export interface LoginRenewalOptions {
  browser?: boolean | undefined;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  cliFolders?: readonly string[];
  notify?: LoginNotify | undefined;
  storageRoot?: string | undefined;
}

export type LoginRenewalResult = "already-handled" | "browser" | "notice" | "superseded";

export type LoginClaim = "claimed" | "existing" | "unrecorded";
