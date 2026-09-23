export declare function reportedVersion(executable: string): Promise<string>;
export declare function signAdHoc(binary: string): void;
export declare const security: (args: string[]) => string;
export declare const codesign: (args: string[]) => void;
export declare function securityWithoutEchoingCredentials(args: string[], failure: string): void;
//# sourceMappingURL=process.d.ts.map