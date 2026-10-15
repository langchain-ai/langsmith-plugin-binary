export type SystemCertificateReader = () => readonly string[];

export interface CertificateEnvironment {
  environment: NodeJS.ProcessEnv;
  warning?: string;
}
