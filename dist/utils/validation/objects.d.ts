import type { JsonValue } from "../../storage/capture/models.js";
import type { OwnDataField } from "./models.js";
export declare function isPlainRecord(value: unknown): value is Record<string, unknown>;
export declare function requirePlainRecord(value: unknown, name: string): Record<string, unknown>;
export declare function ownDataField(source: Record<string, unknown>, key: PropertyKey): OwnDataField;
export declare function requireOwnDataField(source: Record<string, unknown>, key: string): unknown;
export declare function canonicalJsonValue(value: unknown): JsonValue;
export declare function canonicalJsonObject(value: unknown, name: string): Record<string, unknown>;
export declare function canonicalJsonArray(value: unknown, name: string): unknown[];
export declare function requireNonBlankString(value: unknown, name: string): string;
export declare function requireString(value: unknown, name: string): string;
export declare function requireStringArray(value: unknown, name: string): string[];
export declare function requireTimestamp(value: unknown): number | string;
//# sourceMappingURL=objects.d.ts.map