# DX Save

An **agnostic**, asynchronous, and reactive data persistence engine for JavaScript/TypeScript. Designed to seamlessly handle auto-saving, optimistic UI, debouncing, and error recovery without triggering infinite reactive loops.

## 🌟 What is it and what problems does it solve?

When building reactive web applications with auto-save capabilities (where data is persisted to the database as the user types), developers typically face three major challenges:

1.  **Network Overhead:** Sending an HTTP request for every single keystroke.
2.  **Race Conditions:** Two saves of the same record running at the same time, or a failed save wiping out something the user typed afterwards.
3.  **Infinite Reactive Loops (Rollback Hell):** If a save request fails and you revert the value in the frontend (Optimistic UI rollback), your reactive framework detects that rollback as a "new mutation" and tries to save it again, creating an infinite loop.

**DX Save** solves all of this automatically:
*   ⏱️ **Smart Debouncing:** Batches multiple mutations into a single request (defaults to 2000ms). Every object has its own queue, so editing two records never mixes their changes.
*   🔒 **Serialized Saves:** The batches of one target never overlap: a batch waits for the previous save to finish, and edits made in the meantime are merged into it.
*   🛡️ **Reactive Loop Prevention:** Values written by the engine itself (rollbacks and write-backs) are flagged so your reactive listeners ignore them.
*   🔌 **100% Framework Agnostic (Dependency Injection):** Not tied to React, Vue, Angular, or Parse. You inject how it listens to changes and how it saves them.
*   🖼️ **Native File Management:** Intercepts URLs, Blobs, and `<input type="file">` automatically, uploads them, and attaches the resulting file object to the database record.
*   🤫 **Safe Logging:** Logs contain property names and error messages, never the values being saved.

---

## 🚀 Installation

```bash
npm install dx-save
```

Requires Node.js 18 or newer (or any modern browser bundler target with `fetch`).

---

## 📦 Initialization & Setup (Dependency Injection)

Because the library is completely agnostic, it uses a **Fail-Fast** design. If you don't configure the engine, it will throw clear errors to help Developer Experience (DX).

The very first step in your application (e.g., `main.js` or `index.ts`) is to inject your framework's reactive behavior and your backend's upload logic.

```javascript
import { 
  PersistenceReactiveSetFn,
  PersistenceReactiveSetSource,
  PersistenceFormSetFn, 
  PersistenceInternalHandlerSet,
  PersistenceSetLogger,
} from 'dx-save';

// 1. How does your framework listen to global class/store changes?
//    The callback MUST be called with `this` set to the mutated object and
//    BEFORE the new value is applied (the engine reads the previous value from it).
PersistenceReactiveSetFn((className, callback) => {
  // Example using a hypothetical reactive store 'MyStore'
  return MyStore.on(className, function(property, value) {
    return callback.call(this, property, value); 
  }); // optional: return an unsubscribe function
});

// 2. (Optional) Dictionary of your global DB engine instances
PersistenceReactiveSetSource({
  'User': MyGlobalUserDBInstance,
  'Article': MyGlobalArticleDBInstance
});

// 3. How do individual forms interact with the engine?
PersistenceFormSetFn((engineCallback) => {
  // Return a bridge/wrapper that your reactive form system will use
  return async function formMutationListener(property, value, targetObject, rootObject) {
    return await engineCallback(property, value, targetObject, rootObject);
  };
});

// 4. How are files (Images/Documents) uploaded to your server?
PersistenceInternalHandlerSet('Upload', async (fileName, blob) => {
  const formData = new FormData();
  formData.append('file', blob, fileName);
  const res = await fetch('/api/upload', { method: 'POST', body: formData });
  return await res.json(); // Return the object/reference the DB expects
});

// 5. (Optional) Where do logs go? Warnings and errors use `console` by default,
//    info logs are silent. Pass `null` to silence everything.
PersistenceSetLogger({ info: console.debug, warn: console.warn, error: console.error });
```
---

## 🔌 The persistence target ("motor")

Whatever receives the data (a Parse object, a Firebase doc, your own API wrapper) must implement:

| Method | Required | Purpose |
| :--- | :---: | :--- |
| `set(property, value)` | ✅ | Stages a value on the record. |
| `save()` | ✅ | Persists the staged values. May be `async`. |
| `upload(blob, format, property)` | ➖ | Replaces the global `Upload` handler for this target. |
| `revert()` | ➖ | Called after a failed `save()` so the record forgets the values already `set()` (e.g. Parse's `revert()`). |

---

## 📖 Core Use Cases & Examples

### Use Case 1: Auto-saving Forms (`PersistenceForm`)

Ideal for views where you have a specific form editing a specific database record. Changes are debounced, grouped, and sent automatically.

```javascript
import { PersistenceForm } from 'dx-save';

// Assume this is your DB record instance (Parse Object, Firebase Doc, Custom API wrapper)
// It MUST implement .set() and .save() methods, otherwise PersistenceForm throws a TypeError.
const myArticleDBRecord = {
  set: (prop, val) => { /* logic */ },
  save: async () => { /* logic */ }
};

// 1. Instantiate the persistence form
const form = PersistenceForm(
  {
    // The 'target' is mandatory. It's the DB record instance.
    target: myArticleDBRecord, 
    
    // You can format specific properties BEFORE they hit the DB
    price: async (newValue, oldValue, intentObj) => Number(newValue).toFixed(2) 
  }, 
  {
    // Lifecycle Hooks
    preMutation: (prop, val) => console.log(`About to mutate ${prop}`),
    updated: function (savedProps, intents) { console.log('Successfully saved!', savedProps); },
    notUpdated: function (failedProps, intents) { console.error('Save failed, rolled back:', failedProps); }
  },
  1500 // Debounce delay in ms (Defaults to 2000ms)
);

// 2. Connect to your UI (Depends on your framework)
document.querySelector('#titleInput').addEventListener('input', (e) => {
  // The engine takes over from here
  form.title = e.target.value;
});
```

### Use Case 2: Global Entity Tracking (`PersistenceReactive`)

If your application has a global reactive state (e.g., a Store where all "User" records live), you can tell the engine to watch an entire class globally. Each instance gets its own debounce queue.

```javascript
import { PersistenceReactive } from 'dx-save';

// Watch for any reactive change in the 'User' class
PersistenceReactive(
  'User', 
  {
    // Specific property handlers (interceptors)
    password: async (val) => await encryptPassword(val)
  },
  {
    // `this` is the mutated object
    updated: function (savedProps) { toast.success(`User updated: ${savedProps.join(', ')}`); }
  },
  2000 // Optional debounce delay in ms
);
```

### Use Case 3: Painless Image & File Uploads

Uploading files asynchronously before attaching them to a database record is notoriously difficult. The engine provides a magic `images` handler. Just tell it which properties are expected to hold files.

```javascript
const form = PersistenceForm({
  target: myProfileRecord,
  // Tell the engine: "The 'avatar' and 'cover' properties contain files"
  images: { properties: ['avatar', 'cover'] } 
});

// From your UI, you can pass a web URL. 
// The engine will fetch() it (a non-2xx response fails the save), convert it to a Blob,
// call your injected 'Upload' handler, and finally set the resulting file object to the
// DB record. The UI keeps showing `{ url: webPath }`.
form.avatar = { 
  format: 'png', 
  webPath: 'https://example.com/new-photo.png' 
};

// OR, you can pass a native FileList from an <input type="file">.
// `format` is optional: it is taken from the file name or MIME type.
form.cover = { files: fileInputElement.files };
```

---

## ⚙️ Lifecycle Hooks API

The engine exposes a hook system so you can react to events (like showing spinners or toast notifications) without coupling UI logic to the data engine. Hooks only *observe*: an exception thrown by a hook is logged as a warning and never affects persistence.

Passed as the second argument (`hooks` object) to `PersistenceForm` or `PersistenceReactive`:

| Hook | Execution Timing | Parameters |
| :--- | :--- | :--- |
| `preMutation` | *(Form only)* Fired immediately when a change is detected, *before* it is queued. If it is `async`, queuing does not wait for it, so edits keep their order. | `(property, value, object, root)` — `this` is the form |
| `postMutation`| *(Form only)* Fired after the change is queued and `preMutation` has finished. | `(property, value, object, root)` — `this` is the form |
| `preUpdate` | Fired when the debounce finishes, right before calling `.save()`. Not fired when there is nothing to save. | `(toSaveArray, notToSaveArray)` — `this` is the object |
| `updated` | Fired if the persistence engine successfully saved the data. | `(savedPropsArray, saveIntentsObject)` — `this` is the object |
| `notUpdated` | Fired if a value could not be saved and the Optimistic UI Rollback was applied. | `(failedPropsArray, saveIntentsObject)` — `this` is the object |

Properties that end up with the value they started with (`"A" → "B" → "A"` inside one debounce window) are not saved and are not reported as failures.

---

## 🧠 Architecture Deep Dive: The Reactive Rollback Engine

One of the strongest features of this library is its Optimistic UI error handling.

1. User changes the Title from "A" to "B".
2. The UI instantly displays "B" (Optimistic).
3. The engine batches the intent and tries to save "B" to the server.
4. The server throws a 500 Error (or validation fails).
5. The engine silently restores the UI state back to "A" (`previousValue`) and calls `target.revert()` if it exists.

**The Challenge:** If we programmatically change the UI back to "A", reactive frameworks (Vue, MobX, Signals) will detect this as a *new mutation* and try to save "A" to the server, creating a ghost request or an infinite loop.

**The Engine's Solution:** Every write made by the engine (rollbacks, and write-backs of values transformed by handlers or uploads) is marked as a *system write*: a temporary, non-enumerable `__isSystemRollback` flag is set while it happens, and the written value is remembered for a moment so frameworks that notify one tick later are recognised too. Both `PersistenceForm` and `PersistenceReactive` ignore those events, cleanly breaking the infinite loop. Because the flag is non-enumerable, standard parsers (like `JSON.stringify` or SDKs like Parse) will not accidentally save it, and it is always removed in a `finally` block.

**Edits made while a save is in flight** are never clobbered: if the user types again before a failing save is rolled back, their newer value is kept and, should that newer edit fail too, it rolls back to the last value that was really persisted.

> **Contract:** the engine reads the previous value from the object when it is notified, so your reactive listener must call the engine *before* the new value is applied. Frameworks that only notify afterwards (e.g. a `watch` callback) need a bridge that exposes the old value.
>
> A save that never settles blocks the following saves of the same target, so make sure your `save()` and `upload()` have timeouts.

---

## 🧪 Development

```bash
npm test
```

Uses the built-in `node:test` runner; no dependencies required.

---

## 📝 License

MIT License.

Copyright © 2026 [OKZGN](https://okzgn.com)

See [CHANGELOG.md](CHANGELOG.md) for release notes.
