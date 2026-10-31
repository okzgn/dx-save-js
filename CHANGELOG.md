# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to [Semantic Versioning](https://semver.org/).

## [3.0.0] - 2026-10-31

### Fixed
- **Custom upload motors were broken.** `images` uploads called `upload()` on a boolean (`persistenceMotorObjectIsCustom.upload`) instead of on the motor, so every save through a motor-provided `upload()` failed with `... .upload is not a function`.
- **`PersistenceReactive` lost changes between instances.** There was one debounce per class name and the last `this` won, so when two objects of the same class changed within the debounce window only the last one was persisted. Each instance now has its own queue.
- **Rollbacks could overwrite newer edits.** If the user edited a property again while a failing save was in flight, the rollback replaced their newer value. Newer edits are now kept, and inherit the last persisted value as their rollback target.
- **`__isSystemRollback` could stay set forever** if an assignment threw during a rollback, silently disabling every later save. It is now removed in a `finally` block.
- **Successful saves could re-trigger themselves.** The value written back after a save (handler results, upload results) was a plain assignment that reactive listeners saw as a user mutation, which could loop for object values. It now goes through the same system-write protection as rollbacks.
- **Asynchronous frameworks.** Engine writes are also recognised by property and value, so frameworks that notify one tick after the write no longer treat rollbacks as mutations.
- **`previousValue` was lost when a property started as `undefined`**, restoring an intermediate value instead of the original one.
- **File uploads:** a failed download (non-2xx `fetch`) is no longer uploaded as if it were the image; uploads from a `FileList` no longer replace the property with `{ url: undefined }` nor name the file `avatar.undefined` (the format now comes from the file name or MIME type); incompatible values report a clear error instead of a `TypeError`.
- **Failed saves left the record dirty.** The motor is now told to forget the values already `set()` through the new optional `revert()` method.
- **Hook errors were treated as save failures** (a throwing `preUpdate` rolled everything back, a throwing `preMutation` dropped the mutation). Hooks are now isolated: their errors are logged as warnings and never affect persistence.
- **Properties that returned to their original value** within one batch were reported as failed (`notUpdated`) and warned about. They are now skipped silently.
- **`PersistenceForm` did not validate its `target`**, although the docs called it mandatory, and reported success without persisting anything. It now throws a `TypeError` at creation time when `target` does not implement `set()` and `save()`.
- **`PersistenceReactive` with an invalid source** (an object without `set()`/`save()`) now fails the batch and rolls back; a missing source logs a warning instead of silently reporting success.
- **`PersistenceForm` with a `preMutation` hook saved nothing.** It read the previous value after awaiting the hook, when the framework had already applied the new one, so every change looked unchanged. The previous value is now read synchronously, before any hook runs.
- **Slow async `preMutation` hooks reordered edits.** Each edit was queued only after its hook resolved, so a slower hook on an earlier edit persisted a stale value after the newer one. Edits are now queued in the order they happen; hooks no longer delay queuing.
- `PersistenceForm` mixed the changes of nested objects into a single batch persisted through the last object; each mutated object now has its own queue.

### Added
- **Serialized saves:** the batches of a target never overlap; a batch waits for the previous save and merges the edits made meanwhile. This makes the "race conditions" claim of the README true.
- `PersistenceSetLogger(logger)` to route or silence logs.
- Optional `revert()` and `upload(blob, format, property)` methods on persistence targets.
- Optional fourth argument `delay` for `PersistenceReactive` (it was fixed at 2000 ms).
- `PersistenceReactive` returns the unsubscribe function returned by your `PersistenceReactiveSetFn` listener.
- Argument validation in `PersistenceReactiveSetFn`, `PersistenceFormSetFn`, `PersistenceInternalHandlerSet` and `PersistenceReactiveSetSource` (`TypeError`).
- Test suite (`npm test`, built-in `node:test`) and a GitHub Actions workflow running it on Node 18, 20, 22 and 24.
- Full TypeScript declarations: `PersistenceMotor`, `SaveIntent`, hook and handler interfaces, `PersistenceLogger`.

### Changed
- ⚠️ **Logging:** `info` logs are silent by default; warnings and errors still use `console`. Logs no longer include the values being saved (they used to print raw values, e.g. passwords, before handlers ran). Use `PersistenceSetLogger({ info: console.info })` to restore the previous verbosity (property names only).
- ⚠️ **`preUpdate`** is only fired when there is something to save, as documented ("right before calling `.save()`").
- ⚠️ **Node.js 18+** is now required (the engine relies on global `fetch`, and the test runner on `node:test`).
- ⚠️ **TypeScript:** `PersistenceReactive` no longer claims to return `Promise<void>`, and callbacks and sources are typed instead of `Function` / `any`. Code that relied on the loose types may need adjusting.
- Documentation: corrected the hook signatures (hooks receive `(saved, intents)` with `this` set to the object), documented the listener contract (notify *before* applying the value), the motor interface and the new APIs; removed claims the implementation did not meet.
- `index.js` is now hand-written ES module source instead of compiled output.

## [2.0.0]

- Previous release; no changelog was kept.
