export interface UploadLogin {
  configPath: string;
  profile: string;
  workspaceId?: string;
}

export interface LoginProfile extends UploadLogin {
  apiUrl: string;
  tokenHash: string;
  accessTokenHash?: string;
}

export interface UploadCredentialOptions {
  apiKey?: string | undefined;
  apiUrl?: string | undefined;
  apiUrlIsDefault?: boolean;
  workspaceId?: string | undefined;
  env?: NodeJS.ProcessEnv;
}

export type UploadCredential =
  | { kind: "api-key"; apiKey: string; apiUrl: string; workspaceId?: string }
  | { kind: "login"; login: UploadLogin; apiUrl: string; workspaceId?: string }
  | { kind: "none"; reason: string };

export interface LoginReplica {
  apiKey?: string | undefined;
  apiUrl?: string | undefined;
}
