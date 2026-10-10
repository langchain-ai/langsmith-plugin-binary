export type Attribution = Record<string, string>;
export interface RecordedRun {
    run_id: string;
    parent_run_id?: string | undefined;
    trace_id: string;
    dotted_order: string;
    name: string;
    run_type: string;
    project_name?: string | undefined;
    start_time?: string | undefined;
    end_time?: string | undefined;
    tracing: "full" | "metadata";
    open?: boolean | undefined;
    metadata: Record<string, unknown>;
}
export interface TurnRecord {
    path: string;
    origin: string;
    root?: RecordedRun | undefined;
    children: RecordedRun[];
    turnId?: string | undefined;
    closed: boolean;
    delivered: Set<string>;
    fixed: Set<string>;
}
//# sourceMappingURL=models.d.ts.map