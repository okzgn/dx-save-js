/** What a persistence target (DB record, API wrapper...) must implement. */
export interface PersistenceMotor {
  set(property: string, value: any): void | Promise<void>;
  save(): unknown | Promise<unknown>;
  /** Optional: replaces the global `Upload` handler for this target. */
  upload?(blob: Blob, format: string | undefined, property: string): unknown | Promise<unknown>;
  /** Optional: called after a failed `save()` to discard the values already `set()`. */
  revert?(): void | Promise<void>;
}

export interface SaveIntent {
  /** Value to persist (already processed by its handler, if any). */
  value: any;
  /** Value the property had before the batch started; used for rollbacks. */
  previousValue: any;
  /** Value shown in the object instead of `value` (e.g. `{ url }` for uploaded web images). */
  maskValue?: any;
}
export type SaveIntents = Record<string, SaveIntent>;

export type PropertyHandler = (value: any, previousValue: any, intent: SaveIntent) => any | Promise<any>;

export interface ImagesHandler {
  /** Properties that hold files: `{ format, webPath }` or `{ files: FileList }`. */
  properties: string[];
}

export interface PersistenceReactiveHandlers {
  images?: ImagesHandler;
  [property: string]: PropertyHandler | ImagesHandler | undefined;
}

export interface PersistenceFormHandlers {
  /** Mandatory: the object that receives `set()` and `save()`. */
  target: PersistenceMotor;
  images?: ImagesHandler;
  [property: string]: PropertyHandler | ImagesHandler | PersistenceMotor | undefined;
}

export interface PersistenceHooks<T = any> {
  /** Right before `save()`; only runs when there is something to save. */
  preUpdate?(this: T, toSave: string[], notToSave: string[]): void | Promise<void>;
  updated?(this: T, saved: string[], intents: SaveIntents): void | Promise<void>;
  notUpdated?(this: T, failed: string[], intents: SaveIntents): void | Promise<void>;
}

export interface PersistenceFormHooks<T = any> extends PersistenceHooks<T> {
  preMutation?(this: any, property: string, value: any, object: T, root: any): void | Promise<void>;
  postMutation?(this: any, property: string, value: any, object: T, root: any): void | Promise<void>;
}

export interface PersistenceLogger {
  info?(...args: any[]): void;
  warn?(...args: any[]): void;
  error?(...args: any[]): void;
}

/** Replaces the logger. Missing levels are silent; `null` silences everything. */
export declare function PersistenceSetLogger(logger: PersistenceLogger | null): void;

/**
 * Called by the engine once per `PersistenceReactive()`. The listener you register must
 * call `callback` with `this` set to the mutated object, *before* the new value is applied.
 * It may return an unsubscribe function.
 */
export type PersistenceReactiveFnCallbacks = (
  className: string,
  callback: (this: any, property: string, value: any) => boolean
) => (() => void) | void;
export declare function PersistenceReactiveSetFn(fn: PersistenceReactiveFnCallbacks): void;

export type PersistenceReactiveSource = Record<string, PersistenceMotor>;
export declare function PersistenceReactiveSetSource(source: PersistenceReactiveSource): void;

/** Returns whatever unsubscribe function your `PersistenceReactiveSetFn` listener returned. */
export declare function PersistenceReactive(
  className: string,
  handlers?: PersistenceReactiveHandlers,
  hooks?: PersistenceHooks,
  delay?: number
): (() => void) | undefined;

export type PersistenceInternalHandlerFnCallback = (...args: any[]) => any;
export declare function PersistenceInternalHandlerSet(handler: string, fn: PersistenceInternalHandlerFnCallback): void;

export type PersistenceFormFnCallback = (
  callback: (property: string, value: any, object: any, root: any) => Promise<boolean>
) => any;
export declare function PersistenceFormSetFn(fn: PersistenceFormFnCallback): void;

/** Throws a `TypeError` when `handlers.target` does not implement `set()` and `save()`. */
export declare function PersistenceForm<T = any>(
  handlers: PersistenceFormHandlers,
  hooks?: PersistenceFormHooks,
  delay?: number
): T;
