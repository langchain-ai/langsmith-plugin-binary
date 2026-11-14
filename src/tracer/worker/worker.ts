import { appendFileSync, mkdirSync, watch, type FSWatcher } from "node:fs";
import { basename } from "node:path";
import { describe } from "../../utils/errors.js";
import type {
  PositionedHookNote,
  SessionSnapshot,
  TracerSnapshot,
  UploadQueue,
  WorkerOptions,
} from "../models.js";
import { SNAPSHOT_VERSION } from "../snapshot/snapshot-constants.js";
import { releaseLock, takeLock } from "./lock.js";
import { NotesFollower } from "./notes.js";
import { positionNote, readPass, snapshotOf } from "./session.js";
import {
  ABANDONED_EXIT_MS,
  IDLE_EXIT_MS,
  READ_DEBOUNCE_MS,
  TICK_MS,
  UNREAD_NOTES,
  WORKER_RESUMED_LOG,
  WORKER_STARTED_LOG,
  WORKER_STOPPED_LOG,
} from "./worker-constants.js";
import type { StopWorkerRequest, WorkerSession } from "./worker-models.js";

class TracerWorker {
  private readonly sessions = new Map<string, WorkerSession>();
  private readonly scheduled = new Set<string>();
  private readonly waitingForUploads = new Set<string>();
  private readonly queue: UploadQueue;
  private readonly notes: NotesFollower;
  private saved: TracerSnapshot = { version: SNAPSHOT_VERSION, sessions: {} };
  private unsaved = false;
  private lastActivity = Date.now();
  private stopRequested = false;
  private ticker: NodeJS.Timeout | undefined;
  private watcher: FSWatcher | undefined;
  private stop: (() => void) | undefined;

  constructor(private readonly options: WorkerOptions) {
    this.queue = options.createQueue(this.log);
    this.notes = new NotesFollower(options.paths.notes, (line) => this.receiveLine(line));
  }

  readonly log = (line: string): void => {
    try {
      appendFileSync(this.options.paths.log, `${new Date().toISOString()} ${line}\n`);
    } catch {
      return;
    }
  };

  private attempt(failure: string, action: () => void): void {
    try {
      action();
    } catch (error) {
      this.log(`${failure}: ${describe(error)}`);
    }
  }

  start(): void {
    this.log(`${WORKER_STARTED_LOG} ${process.pid}`);
    this.attempt("could not upgrade older state", () => this.options.upgradeState());
    this.attempt("could not load the snapshot", () => {
      this.saved = this.options.snapshots.load() ?? this.saved;
    });
    for (const snapshot of Object.values(this.saved.sessions)) {
      this.sessions.set(snapshot.sessionId, this.createSession(snapshot));
      this.scheduleRead(snapshot.sessionId);
    }
    this.notes.resume(this.saved.notes ?? UNREAD_NOTES);
    this.takeNotes();
    const notesName = basename(this.options.paths.notes);
    this.watcher = watch(this.options.paths.folder, (_event, name) => {
      if (name === null || name === notesName) this.takeNotes();
    });
    this.watcher.on("error", (error) => this.log(`stopped watching notes: ${describe(error)}`));
    this.ticker = setInterval(() => this.tick(), TICK_MS);
  }

  stopped(): Promise<void> {
    return new Promise((resolve) => {
      this.stop = resolve;
    });
  }

  private createSession({ builderState, ...saved }: SessionSnapshot): WorkerSession {
    const session: WorkerSession = {
      ...saved,
      builder: this.options.createBuilder({
        sessionId: saved.sessionId,
        savedState: builderState,
        sink: {
          post: (run) => this.queue.post(session.sessionId, session.writer, run),
          patch: (patch) => this.queue.patch(session.sessionId, session.writer, patch),
        },
      }),
    };
    return session;
  }

  private receive(note: PositionedHookNote): void {
    this.lastActivity = Date.now();
    const session =
      this.sessions.get(note.sessionId) ??
      this.createSession({
        sessionId: note.sessionId,
        integration: note.integration,
        writer: note.writer,
        bookmarks: {},
        pendingNotes: [],
        builderState: undefined,
        ended: false,
      });
    this.sessions.set(session.sessionId, session);
    session.integration = note.integration;
    session.writer = note.writer;
    session.ended = false;
    if (note.transcriptPath !== undefined)
      session.bookmarks[note.transcriptPath] ??= { path: note.transcriptPath, offset: 0 };
    session.pendingNotes.push(positionNote(session, note));
    this.scheduleRead(session.sessionId);
  }

  private receiveLine(text: string): void {
    this.unsaved = true;
    try {
      const note = JSON.parse(text) as PositionedHookNote | StopWorkerRequest;
      if ("stopWorker" in note) {
        this.log(`stopping for a newer worker ${note.version}`);
        this.stopRequested = true;
        return;
      }
      if (typeof note.sessionId !== "string") throw new Error("the note has no session id");
      this.receive(note);
    } catch (error) {
      this.log(`skipped a bad hook note: ${describe(error)}`);
    }
  }

  private scheduleRead(sessionId: string): void {
    if (this.scheduled.has(sessionId)) return;
    this.scheduled.add(sessionId);
    setTimeout(() => {
      this.scheduled.delete(sessionId);
      this.read(sessionId);
    }, READ_DEBOUNCE_MS);
  }

  private read(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session === undefined) return;
    this.attempt(`read failed for ${sessionId}`, () => {
      if (readPass(session, this.options.readNewLines, this.log, () => this.queue.full())) {
        this.lastActivity = Date.now();
        this.unsaved = true;
      }
      if (this.queue.full()) this.waitingForUploads.add(sessionId);
      this.queue.flush();
    });
  }

  private takeNotes(): void {
    this.attempt("could not take the notes", () => this.notes.take());
  }

  private saveSnapshot(): void {
    if (!this.unsaved || this.notes.rotating()) return;
    const sessions = [...this.sessions.values()];
    if (sessions.some((session) => this.queue.pendingFor(session.sessionId) > 0)) return;
    for (const session of sessions)
      if (session.ended && session.pendingNotes.length === 0)
        this.sessions.delete(session.sessionId);
    this.saved = {
      version: SNAPSHOT_VERSION,
      sessions: Object.fromEntries(
        [...this.sessions.values()].map((s) => [s.sessionId, snapshotOf(s)]),
      ),
      notes: this.notes.bookmark(),
    };
    this.unsaved = false;
    this.attempt("could not save the snapshot", () => this.options.snapshots.save(this.saved));
  }

  private shouldExit(): boolean {
    const busy =
      this.scheduled.size > 0 ||
      this.waitingForUploads.size > 0 ||
      this.notes.rotating() ||
      !this.queue.idle();
    if (busy) return false;
    const quiet = Date.now() - this.lastActivity;
    return (
      this.stopRequested ||
      quiet >= ABANDONED_EXIT_MS ||
      (quiet >= IDLE_EXIT_MS && this.sessions.size === 0 && !this.notes.unread())
    );
  }

  private resumeReadsAfterUploads(): void {
    if (this.queue.full()) return;
    for (const sessionId of this.waitingForUploads) this.scheduleRead(sessionId);
    this.waitingForUploads.clear();
  }

  private tick(): void {
    this.takeNotes();
    this.queue.flush();
    this.resumeReadsAfterUploads();
    this.saveSnapshot();
    if (this.shouldExit()) this.exit();
  }

  private exit(): void {
    const { lock } = this.options.paths;
    this.unsaved = true;
    this.saveSnapshot();
    releaseLock(lock);
    if (!this.stopRequested && this.notes.unread() && takeLock(lock, this.options.version)) {
      this.log(`${WORKER_RESUMED_LOG} ${process.pid}`);
      return;
    }
    clearInterval(this.ticker);
    this.watcher?.close();
    this.log(`${WORKER_STOPPED_LOG} ${process.pid}`);
    this.stop?.();
  }
}

export async function runWorker(options: WorkerOptions): Promise<void> {
  mkdirSync(options.paths.folder, { recursive: true });
  if (!takeLock(options.paths.lock, options.version)) return;
  const worker = new TracerWorker(options);
  const stopped = worker.stopped();
  try {
    worker.start();
  } catch (error) {
    worker.log(`worker failed to start: ${describe(error)}`);
    releaseLock(options.paths.lock);
    return;
  }
  await stopped;
}
