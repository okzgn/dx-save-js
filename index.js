// DX Save: agnostic, asynchronous and reactive data persistence engine.

const DEFAULT_DELAY = 2000;
const SYSTEM_FLAG = '__isSystemRollback';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const noop = () => { };
const isObjectLike = (value) => value !== null && typeof value === 'object';
const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const errorMessage = (e) => (e && e.message) || String(e);
const normalizeDelay = (delay) => (Number.isFinite(delay) && delay >= 0 ? delay : DEFAULT_DELAY);

function assertFunction(name, fn) {
    if (typeof fn !== 'function') {
        throw new TypeError('DX Save: ' + name + ' expects a function.');
    }
}

function isMotor(candidate) {
    return isObjectLike(candidate) && typeof candidate.set === 'function' && typeof candidate.save === 'function';
}

function isChanged({ value, previousValue }) {
    // Objects may have been mutated in place, so they can't be compared by reference.
    if (isObjectLike(value) && isObjectLike(previousValue)) {
        return true;
    }
    return !Object.is(value, previousValue);
}

// ---------------------------------------------------------------------------
// Logging (values are never logged, only property names and error messages)
// ---------------------------------------------------------------------------

let logger = { info: noop, warn: (...args) => console.warn(...args), error: (...args) => console.error(...args) };

/**
 * Replaces the logger. Levels that are missing are silent; `null` silences everything.
 */
export function PersistenceSetLogger(custom) {
    logger = { info: noop, warn: noop, error: noop, ...(custom || {}) };
}

function log(level, ...args) {
    try {
        (logger[level] || noop)(...args);
    }
    catch (e) {
        // A broken logger must never break persistence.
    }
}

// ---------------------------------------------------------------------------
// System writes: values written by the engine itself (rollbacks, write-backs)
// must never be mistaken for user mutations by the reactive framework.
// ---------------------------------------------------------------------------

const systemWrites = new WeakMap();

function systemWrite(object, property, value) {
    let writes = systemWrites.get(object);
    if (!writes) {
        writes = new Map();
        systemWrites.set(object, writes);
    }
    writes.set(property, value);
    // Frameworks that notify asynchronously fire after the flag is gone; the
    // remembered value lets isSystemWrite() recognise them for a short while.
    const timer = setTimeout(function () {
        if (writes.has(property) && Object.is(writes.get(property), value)) {
            writes.delete(property);
        }
    }, 0);
    if (timer && typeof timer.unref === 'function') {
        timer.unref();
    }
    Object.defineProperty(object, SYSTEM_FLAG, {
        value: true,
        writable: true,
        enumerable: false,
        configurable: true
    });
    try {
        object[property] = value;
    }
    finally {
        delete object[SYSTEM_FLAG];
    }
}

function isSystemWrite(object, property, value) {
    if (!isObjectLike(object) && typeof object !== 'function') {
        return false;
    }
    const flagged = Boolean(object[SYSTEM_FLAG]);
    const writes = systemWrites.get(object);
    if (writes && writes.has(property) && (flagged || Object.is(writes.get(property), value))) {
        writes.delete(property);
        return true;
    }
    return flagged;
}

// ---------------------------------------------------------------------------
// Hooks: they observe persistence, they never influence it.
// ---------------------------------------------------------------------------

async function callHook(hooks, name, thisArg, ...args) {
    if (!hooks || typeof hooks[name] !== 'function') {
        return;
    }
    try {
        await hooks[name].apply(thisArg, args);
    }
    catch (e) {
        log('warn', 'DX Save: "' + name + '" hook failed:', errorMessage(e));
    }
}

// ---------------------------------------------------------------------------
// Intent queue: debounces mutations and serializes the saves of one target.
// ---------------------------------------------------------------------------

class IntentQueue {
    constructor(delay, run) {
        this.delay = normalizeDelay(delay);
        this.run = run;
        this.pending = Object.create(null);
        this.timer = null;
        this.tail = Promise.resolve();
    }
    add(property, value, readCurrentValue) {
        // The first mutation of a batch captures the value to roll back to.
        const intent = this.pending[property] || (this.pending[property] = { previousValue: readCurrentValue() });
        intent.value = value;
        clearTimeout(this.timer);
        this.timer = setTimeout(() => this.flush(), this.delay);
    }
    flush() {
        this.timer = null;
        // Batches of the same target never overlap: each one waits for the previous save.
        // The batch is taken only when its turn comes, so edits made while waiting are
        // merged into it and stay visible to the rollback of the save in flight.
        this.tail = this.tail
            .then(() => {
                const batch = this.pending;
                if (!Object.keys(batch).length) {
                    return;
                }
                this.pending = Object.create(null);
                return this.run(batch, this);
            })
            .catch((e) => log('error', 'DX Save: unexpected persistence error:', errorMessage(e)));
        return this.tail;
    }
}

// ---------------------------------------------------------------------------
// Persistence engine
// ---------------------------------------------------------------------------

let PersistenceInternalHandlers = {
    'Upload': async function () { throw new Error('DX Save: initialize with PersistenceInternalHandlerSet("Upload", fn)'); }
};

export function PersistenceInternalHandlerSet(handler, fn) {
    assertFunction('PersistenceInternalHandlerSet', fn);
    PersistenceInternalHandlers[handler] = fn;
}

function fileExtension(file) {
    const fromName = typeof file.name === 'string' && file.name.includes('.') ? file.name.split('.').pop() : '';
    const fromType = typeof file.type === 'string' && file.type.includes('/') ? file.type.split('/').pop() : '';
    return (fromName || fromType || '').toLowerCase() || undefined;
}

async function uploadFile(property, intent, motor) {
    const value = intent.value;
    let blob;
    let format;
    let webPath;
    if (value && value.webPath && value.format) {
        webPath = value.webPath;
        format = value.format;
        const response = await fetch(webPath);
        if (!response.ok) {
            throw new Error('Could not fetch "' + webPath + '" (HTTP ' + response.status + ').');
        }
        blob = await response.blob();
    }
    else if (value && value.files && value.files.length && value.files[0].name && value.files[0].size) {
        blob = value.files[0];
        format = value.format || fileExtension(blob);
    }
    else {
        throw new Error('File is incompatible for uploading.');
    }
    if (motor && typeof motor.upload === 'function') {
        intent.value = await motor.upload(blob, format, property);
    }
    else {
        intent.value = await PersistenceInternalHandlers.Upload(format ? property + '.' + format : property, blob);
    }
    if (webPath) {
        intent.maskValue = { url: webPath };
    }
}

async function applyHandler(property, intent, handlers, motor) {
    if (hasOwn(handlers, property) && typeof handlers[property] === 'function') {
        log('info', 'DX Save: running handler for', property);
        intent.value = await handlers[property](intent.value, intent.previousValue, intent);
        return;
    }
    const images = handlers.images;
    if (isObjectLike(images) && Array.isArray(images.properties) && images.properties.includes(property)) {
        log('info', 'DX Save: uploading file for', property);
        await uploadFile(property, intent, motor);
    }
}

async function revertMotor(motor) {
    if (!motor || typeof motor.revert !== 'function') {
        return;
    }
    try {
        await motor.revert();
    }
    catch (e) {
        log('warn', 'DX Save: persistence source revert failed:', errorMessage(e));
    }
}

function writeBack(object, properties, saveIntents, queue) {
    for (const property of properties) {
        // A newer edit is already queued: writing the older value would clobber it.
        if (queue.pending[property]) {
            continue;
        }
        const intent = saveIntents[property];
        const next = intent.maskValue !== undefined ? intent.maskValue : intent.value;
        try {
            if (!Object.is(object[property], next)) {
                systemWrite(object, property, next);
            }
        }
        catch (e) {
            log('error', 'DX Save: could not write back "' + property + '":', errorMessage(e));
        }
    }
}

function rollback(object, properties, saveIntents, queue) {
    for (const property of properties) {
        const intent = saveIntents[property];
        const newer = queue.pending[property];
        if (newer) {
            // The user already edited this property again: keep their value, but
            // make sure a failure of that newer edit rolls back to the persisted one.
            newer.previousValue = intent.previousValue;
            continue;
        }
        try {
            systemWrite(object, property, intent.previousValue);
        }
        catch (e) {
            log('error', 'DX Save: could not roll back "' + property + '":', errorMessage(e));
        }
    }
}

async function PersistenceInternalHandler(saveIntents, motor, object, handlers, hooks, queue) {
    const properties = Object.keys(saveIntents);
    log('info', 'DX Save: save intent for', properties);
    const hasMotor = motor !== undefined && motor !== null;
    const motorIsValid = hasMotor && isMotor(motor);
    if (!hasMotor) {
        log('warn', 'DX Save: no persistence source available, changes are not persisted.');
    }
    else if (!motorIsValid) {
        log('error', 'DX Save: the persistence source must implement set() and save().');
    }
    let toSave = [];
    let notToSave = [];
    for (const property of properties) {
        const intent = saveIntents[property];
        if (!isChanged(intent)) {
            continue;
        }
        if (hasMotor && !motorIsValid) {
            notToSave.push(property);
            continue;
        }
        let stage = 'handler';
        try {
            await applyHandler(property, intent, handlers, motor);
            stage = 'set';
            if (motorIsValid) {
                await motor.set(property, intent.value);
            }
            toSave.push(property);
        }
        catch (e) {
            log('error', 'DX Save: "' + property + '" ' + stage + ' error:', errorMessage(e));
            notToSave.push(property);
        }
    }
    if (toSave.length) {
        callHook(hooks, 'preUpdate', object, toSave, notToSave);
        try {
            if (motorIsValid) {
                await motor.save();
            }
        }
        catch (e) {
            log('error', 'DX Save: persistence save error:', errorMessage(e));
            await revertMotor(motor);
            notToSave = toSave.concat(notToSave);
            toSave = [];
        }
    }
    if (toSave.length) {
        log('info', 'DX Save: values updated:', toSave);
        writeBack(object, toSave, saveIntents, queue);
        callHook(hooks, 'updated', object, toSave, Object.assign({}, saveIntents));
    }
    if (notToSave.length) {
        log('warn', 'DX Save: values NOT updated:', notToSave);
        rollback(object, notToSave, saveIntents, queue);
        callHook(hooks, 'notUpdated', object, notToSave, Object.assign({}, saveIntents));
    }
}

// ---------------------------------------------------------------------------
// PersistenceReactive: watches every instance of a reactive class
// ---------------------------------------------------------------------------

let PersistenceReactiveFn = function () { throw new Error('DX Save: initialize with PersistenceReactiveSetFn(fn)'); };
export function PersistenceReactiveSetFn(fn) {
    assertFunction('PersistenceReactiveSetFn', fn);
    PersistenceReactiveFn = fn;
}

let PersistenceReactiveSource = {};
export function PersistenceReactiveSetSource(source) {
    if (!isObjectLike(source)) {
        throw new TypeError('DX Save: PersistenceReactiveSetSource expects an object.');
    }
    PersistenceReactiveSource = source;
}

export function PersistenceReactive(className, handlers = {}, hooks = {}, delay = DEFAULT_DELAY) {
    handlers = handlers || {};
    hooks = hooks || {};
    // One queue per instance: edits of different objects never get mixed.
    const queues = new WeakMap();
    const unsubscribe = PersistenceReactiveFn(className, function (property, value) {
        if (isSystemWrite(this, property, value)) {
            return true;
        }
        try {
            if (!isObjectLike(this)) {
                throw new Error('the reactive callback must be called with the mutated object as "this".');
            }
            let queue = queues.get(this);
            if (!queue) {
                queue = new IntentQueue(delay, (batch, owner) => PersistenceInternalHandler(batch, PersistenceReactiveSource[className], this, handlers, hooks, owner));
                queues.set(this, queue);
            }
            queue.add(property, value, () => this[property]);
        }
        catch (e) {
            log('error', 'DX Save: PersistenceReactive error:', errorMessage(e));
            return false;
        }
        return true;
    });
    return typeof unsubscribe === 'function' ? unsubscribe : undefined;
}

// ---------------------------------------------------------------------------
// PersistenceForm: auto-saves a form bound to one persistence target
// ---------------------------------------------------------------------------

let PersistenceFormFn = function () { throw new Error('DX Save: initialize with PersistenceFormSetFn(fn)'); };
export function PersistenceFormSetFn(fn) {
    assertFunction('PersistenceFormSetFn', fn);
    PersistenceFormFn = fn;
}

export function PersistenceForm(handlers = {}, hooks = {}, delay = DEFAULT_DELAY) {
    handlers = handlers || {};
    hooks = hooks || {};
    if (!isMotor(handlers.target)) {
        throw new TypeError('DX Save: PersistenceForm requires handlers.target implementing set() and save().');
    }
    // One queue per mutated object, so nested objects of a form are saved independently.
    const queues = new WeakMap();
    const persistenceForm = PersistenceFormFn(async function (property, value, object, root) {
        if (isSystemWrite(object, property, value) || isSystemWrite(root, property, value)) {
            return true;
        }
        if (!isObjectLike(object)) {
            log('error', 'DX Save: PersistenceForm error: the mutated object is missing.');
            return false;
        }
        // Everything up to queue.add() runs synchronously: the framework applies the new
        // value as soon as this callback yields, and slow async hooks must not reorder edits.
        const preMutation = callHook(hooks, 'preMutation', persistenceForm, property, value, object, root);
        let accepted = true;
        try {
            let queue = queues.get(object);
            if (!queue) {
                queue = new IntentQueue(delay, (batch, owner) => PersistenceInternalHandler(batch, handlers.target, object, handlers, hooks, owner));
                queues.set(object, queue);
            }
            queue.add(property, value, () => object[property]);
        }
        catch (e) {
            log('error', 'DX Save: PersistenceForm error:', errorMessage(e));
            accepted = false;
        }
        await preMutation;
        await callHook(hooks, 'postMutation', persistenceForm, property, value, object, root);
        return accepted;
    });
    return persistenceForm;
}
