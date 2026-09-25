export declare function fail(field: string, wanted: string): never;
export declare class Section {
    private readonly source;
    private readonly scope;
    constructor(source: Record<string, unknown>, scope?: string);
    private name;
    raw(field: string): unknown;
    fields(): [string, unknown][];
    text(field: string): string;
    matching(field: string, allowed: RegExp, wanted: string): string;
    repositoryPath(field: string): string;
    repositoryPaths(field: string): string[];
    strings(field: string): string[];
    lines(field: string): string[];
    section(field: string): Section;
}
//# sourceMappingURL=validation.d.ts.map