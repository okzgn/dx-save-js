# DX Save

An **agnostic**, asynchronous, and reactive data persistence engine for JavaScript/TypeScript. Designed to seamlessly handle auto-saving, optimistic UI, debouncing, and error recovery without triggering infinite reactive loops.

## 🌟 What is it and what problems does it solve?

When building reactive web applications with auto-save capabilities (where data is persisted to the database as the user types), developers typically face three major challenges:

1.  **Network Overhead:** Sending an HTTP request for every single keystroke.
2.  **Race Conditions:** Saving obsolete data if the user types faster than the server can respond.
3.  **Infinite Reactive Loops (Rollback Hell):** If a save request fails and you revert the value in the frontend (Optimistic UI rollback), your reactive framework detects that rollback as a "new mutation" and tries to save it again, creating an infinite loop.

**Reactive Persistence Engine** solves all of this automatically:
*   ⏱️ **Smart Debouncing:** Batches multiple mutations into a single network request (defaults to 2000ms) with zero memory leaks.
*   🛡️ **Reactive Loop Prevention:** Uses non-enumerable properties (`__isSystemRollback`) to revert data temporarily without re-triggering reactive listeners.
*   🔌 **100% Framework Agnostic (Dependency Injection):** Not tied to React, Vue, Angular, or Parse. You inject how it listens to changes and how it saves them.
*   🖼️ **Native File Management:** Intercepts URLs, Blobs, and `<input type="file">` automatically, uploads them, and attaches the resulting file object to the database record.

---

## 🚀 Installation

```bash
npm install dx-save
```

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
} from 'dx-save';

// 1. How does your framework listen to global class/store changes?
PersistenceReactiveSetFn((className, callback) => {
  // Example using a hypothetical reactive store 'MyStore'
  MyStore.on(className, function(property, value) {
    // It's vital to bind the 'this' context if your framework relies on it
    callback.call(this, property, value); 
  });
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
    return await engineCallback.call(this, property, value, targetObject, rootObject);
  };
});

// 4. How are files (Images/Documents) uploaded to your server?
PersistenceInternalHandlerSet('Upload', async (fileName, blob) => {
  const formData = new FormData();
  formData.append('file', blob, fileName);
  const res = await fetch('/api/upload', { method: 'POST', body: formData });
  return await res.json(); // Return the object/reference the DB expects
});
```
---

## 📖 Core Use Cases & Examples

### Use Case 1: Auto-saving Forms (`PersistenceForm`)

Ideal for views where you have a specific form editing a specific database record. Changes are debounced, grouped, and sent automatically.

```javascript
import { PersistenceForm } from 'dx-save';

// Assume this is your DB record instance (Parse Object, Firebase Doc, Custom API wrapper)
// It MUST implement .set() and .save() methods.
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
    updated: (obj, savedProps, intents) => console.log('Successfully saved!', savedProps),
    notUpdated: (obj, failedProps) => console.error('Save failed, rolling back...', failedProps)
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

If your application has a global reactive state (e.g., a Store where all "User" records live), you can tell the engine to watch an entire class globally.

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
    updated: (obj, toSaveProps) => toast.success(`User updated: ${toSaveProps.join(', ')}`)
  }
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
// The engine will fetch() it, convert it to a Blob, call your injected 'Upload' 
// handler, and finally set the resulting file object to the DB record.
form.avatar = { 
  format: 'png', 
  webPath: 'https://example.com/new-photo.png' 
};

// OR, you can pass a native FileList from an <input type="file">
form.cover = { files: fileInputElement.files };
```

---

## ⚙️ Lifecycle Hooks API

The engine exposes a powerful hook system so you can react to events (like showing spinners or toast notifications) without coupling UI logic to the data engine. 

Passed as the second argument (`hooks` object) to `PersistenceForm` or `PersistenceReactive`:

| Hook | Execution Timing | Parameters |
| :--- | :--- | :--- |
| `preMutation` | Fired immediately when a change is detected, *before* the debounce timer starts. | `(property, value, object, root)` |
| `postMutation`| Fired immediately after the change is added to the debounce queue. | `(property, value, object, root)` |
| `preUpdate` | Fired when the debounce finishes, right before calling `.save()` on the DB target. | `(toSaveArray, notToSaveArray)` *(Contextualized to `object`)* |
| `updated` | Fired if the persistence engine successfully saved the data. | `(toSaveArray, saveIntentsObject)` *(Contextualized to `object`)* |
| `notUpdated` | Fired if the HTTP/DB request failed and the Optimistic UI Rollback was applied. | `(failedPropsArray, saveIntentsObject)` *(Contextualized to `object`)* |

---

## 🧠 Architecture Deep Dive: The Reactive Rollback Engine

One of the strongest features of this library is its Optimistic UI error handling.

1. User changes the Title from "A" to "B".
2. The UI instantly displays "B" (Optimistic).
3. The engine batches the intent and tries to save "B" to the server.
4. The server throws a 500 Error (or validation fails).
5. The engine silently restores the UI state back to "A" (`previousValue`).

**The Challenge:** If we programmatically change the UI back to "A", reactive frameworks (Vue, MobX, Signals) will detect this as a *new mutation* and try to save "A" to the server, creating a ghost request or an infinite loop.

**The Engine's Solution:** Before rolling back, the engine injects a temporary, non-enumerable property `__isSystemRollback`.

Both `PersistenceForm` and `PersistenceReactive` validate if `__isSystemRollback` is present. If it is, **they ignore the event**, cleanly breaking the infinite loop. Because it uses `enumerable: false`, it guarantees that standard parsers (like `JSON.stringify` or SDKs like Parse) will not accidentally save this internal flag to your database.

---

## 📝 License

MIT License.

Copyright © 2026 [OKZGN](https://okzgn.com)