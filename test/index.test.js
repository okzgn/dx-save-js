import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as dx from '../index.js';

const DELAY = 5;
const wait = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));
const errorsOf = (logs) => logs.filter((entry) => entry[0] === 'error');
const warningsOf = (logs) => logs.filter((entry) => entry[0] === 'warn');

function setup() {
    const listeners = {};
    const logs = [];
    dx.PersistenceSetLogger({
        info: (...args) => logs.push(['info', ...args]),
        warn: (...args) => logs.push(['warn', ...args]),
        error: (...args) => logs.push(['error', ...args])
    });
    dx.PersistenceReactiveSetFn((className, callback) => { listeners[className] = callback; });
    dx.PersistenceReactiveSetSource({});
    dx.PersistenceFormSetFn((callback) => callback);
    return { listeners, logs };
}

function createMotor({ save = async () => { }, ...extra } = {}) {
    const calls = [];
    return {
        calls,
        set(property, value) { calls.push(['set', property, value]); },
        async save() { calls.push(['save']); return save(); },
        ...extra
    };
}

// Minimal reactive object: notifies *before* applying the new value, like the engine expects.
function reactive(target, listener) {
    const proxy = new Proxy(target, {
        set(object, property, value) {
            listener.call(proxy, property, value);
            object[property] = value;
            return true;
        }
    });
    return proxy;
}

// Form bridge as a framework uses it: notifies and applies the value in the same tick.
function mutateForm(form, object, property, value, root = object) {
    const accepted = form(property, value, object, root);
    object[property] = value;
    return accepted;
}

// Framework that notifies asynchronously and exposes the old value until it does.
function deferredReactive(target, listener) {
    const stale = new Map();
    const proxy = new Proxy(target, {
        get(object, property) { return stale.has(property) ? stale.get(property) : object[property]; },
        set(object, property, value) {
            stale.set(property, object[property]);
            object[property] = value;
            queueMicrotask(() => {
                try { listener.call(proxy, property, value); }
                finally { stale.delete(property); }
            });
            return true;
        }
    });
    return proxy;
}

test('PersistenceReactive persists a mutation and fires the updated hook', async () => {
    const { listeners, logs } = setup();
    const motor = createMotor();
    dx.PersistenceReactiveSetSource({ User: motor });
    const updated = [];
    dx.PersistenceReactive('User', {}, { updated(saved, intents) { updated.push([this, saved, intents]); } }, DELAY);
    const user = reactive({ name: 'A' }, listeners.User);
    user.name = 'B';
    await wait();
    assert.deepEqual(motor.calls, [['set', 'name', 'B'], ['save']]);
    assert.equal(updated.length, 1);
    assert.equal(updated[0][0], user);
    assert.deepEqual(updated[0][1], ['name']);
    assert.deepEqual(updated[0][2].name, { previousValue: 'A', value: 'B' });
    assert.deepEqual(errorsOf(logs), []);
});

test('PersistenceReactive keeps the edits of different instances apart', async () => {
    const { listeners } = setup();
    const motor = createMotor();
    dx.PersistenceReactiveSetSource({ User: motor });
    dx.PersistenceReactive('User', {}, {}, DELAY);
    const a = reactive({ name: 'A' }, listeners.User);
    const b = reactive({ name: 'B' }, listeners.User);
    a.name = 'A2';
    b.name = 'B2';
    await wait();
    const sets = motor.calls.filter((call) => call[0] === 'set').map((call) => call[2]).sort();
    assert.deepEqual(sets, ['A2', 'B2']);
    assert.equal(motor.calls.filter((call) => call[0] === 'save').length, 2);
});

test('uploads files through the upload() of a custom motor', async () => {
    const { listeners, logs } = setup();
    const motor = createMotor({ upload: async (blob, format, property) => ({ uploaded: true, blob, format, property }) });
    dx.PersistenceReactiveSetSource({ User: motor });
    dx.PersistenceReactive('User', { images: { properties: ['avatar'] } }, {}, DELAY);
    const file = { name: 'photo.PNG', size: 3 };
    const user = reactive({ avatar: null }, listeners.User);
    user.avatar = { files: [file] };
    await wait();
    assert.deepEqual(errorsOf(logs), []);
    assert.deepEqual(motor.calls.map((call) => call[0]), ['set', 'save']);
    const stored = motor.calls[0][2];
    assert.equal(stored.uploaded, true);
    assert.equal(stored.blob, file);
    assert.equal(stored.format, 'png');
    assert.equal(stored.property, 'avatar');
    assert.equal(user.avatar, stored);
});

test('uploads web images through the global Upload handler and masks the value', async () => {
    const { listeners, logs } = setup();
    const motor = createMotor();
    dx.PersistenceReactiveSetSource({ User: motor });
    dx.PersistenceInternalHandlerSet('Upload', async (fileName, blob) => ({ fileName, blob }));
    dx.PersistenceReactive('User', { images: { properties: ['avatar'] } }, {}, DELAY);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => ({ ok: true, status: 200, blob: async () => ({ fetched: url }) });
    try {
        const user = reactive({ avatar: null }, listeners.User);
        user.avatar = { format: 'png', webPath: 'https://example.com/me.png' };
        await wait();
        assert.deepEqual(errorsOf(logs), []);
        assert.deepEqual(motor.calls[0], ['set', 'avatar', { fileName: 'avatar.png', blob: { fetched: 'https://example.com/me.png' } }]);
        assert.deepEqual(user.avatar, { url: 'https://example.com/me.png' });
    }
    finally {
        globalThis.fetch = originalFetch;
    }
});

test('does not upload the body of a failed download and rolls back', async () => {
    const { listeners, logs } = setup();
    const motor = createMotor();
    dx.PersistenceReactiveSetSource({ User: motor });
    dx.PersistenceInternalHandlerSet('Upload', async () => { throw new Error('must not be called'); });
    const failed = [];
    dx.PersistenceReactive('User', { images: { properties: ['avatar'] } }, { notUpdated(props) { failed.push(props); } }, DELAY);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: false, status: 404, blob: async () => ({}) });
    try {
        const user = reactive({ avatar: 'old' }, listeners.User);
        user.avatar = { format: 'png', webPath: 'https://example.com/missing.png' };
        await wait();
        assert.equal(user.avatar, 'old');
        assert.deepEqual(failed, [['avatar']]);
        assert.deepEqual(motor.calls, []);
        assert.match(errorsOf(logs)[0][2], /HTTP 404/);
    }
    finally {
        globalThis.fetch = originalFetch;
    }
});

test('a failed save rolls back once, reverts the motor and leaves no flag behind', async () => {
    const { listeners } = setup();
    const motor = createMotor({ save: async () => { throw new Error('boom'); } });
    motor.revert = () => { motor.calls.push(['revert']); };
    dx.PersistenceReactiveSetSource({ User: motor });
    const failed = [];
    dx.PersistenceReactive('User', {}, { notUpdated(props) { failed.push(props); } }, DELAY);
    const user = reactive({ title: 'A' }, listeners.User);
    user.title = 'B';
    await wait();
    assert.equal(user.title, 'A');
    assert.deepEqual(failed, [['title']]);
    // The rollback itself must not be saved again.
    assert.deepEqual(motor.calls, [['set', 'title', 'B'], ['save'], ['revert']]);
    assert.equal('__isSystemRollback' in user, false);
});

test('rollbacks of frameworks that notify asynchronously are not saved again', async () => {
    const { listeners } = setup();
    const motor = createMotor({ save: async () => { throw new Error('boom'); } });
    dx.PersistenceReactiveSetSource({ User: motor });
    dx.PersistenceReactive('User', {}, {}, DELAY);
    const user = deferredReactive({ name: 'A' }, listeners.User);
    user.name = 'B';
    await wait();
    assert.equal(user.name, 'A');
    assert.deepEqual(motor.calls, [['set', 'name', 'B'], ['save']]);
});

test('values written back after a successful save do not trigger another save', async () => {
    const { listeners } = setup();
    const motor = createMotor();
    dx.PersistenceReactiveSetSource({ User: motor });
    dx.PersistenceReactive('User', { price: async (value) => Number(value).toFixed(2) }, {}, DELAY);
    const user = reactive({ price: 0 }, listeners.User);
    user.price = 10;
    await wait();
    assert.equal(user.price, '10.00');
    assert.deepEqual(motor.calls, [['set', 'price', '10.00'], ['save']]);
});

test('saves of one target are serialized and a newer edit survives a failed save', async () => {
    const { listeners } = setup();
    const gates = [];
    const motor = createMotor({ save: () => new Promise((resolve, reject) => gates.push({ resolve, reject })) });
    dx.PersistenceReactiveSetSource({ User: motor });
    dx.PersistenceReactive('User', {}, {}, DELAY);
    const user = reactive({ name: 'A' }, listeners.User);

    user.name = 'B';
    await wait();
    assert.deepEqual(motor.calls, [['set', 'name', 'B'], ['save']]);

    user.name = 'C';
    await wait();
    assert.equal(motor.calls.length, 2, 'the second batch must wait for the first save');

    gates[0].reject(new Error('first save failed'));
    await wait();
    assert.equal(user.name, 'C', 'the newer edit must not be rolled back');
    assert.deepEqual(motor.calls.slice(2), [['set', 'name', 'C'], ['save']]);

    gates[1].reject(new Error('second save failed'));
    await wait();
    assert.equal(user.name, 'A', 'rolls back to the last persisted value, not to the unsaved "B"');
});

test('rolls back to undefined when the property did not exist before', async () => {
    const { listeners } = setup();
    const motor = createMotor({ save: async () => { throw new Error('boom'); } });
    dx.PersistenceReactiveSetSource({ User: motor });
    dx.PersistenceReactive('User', {}, {}, DELAY);
    const user = reactive({}, listeners.User);
    user.nickname = 1;
    user.nickname = 2;
    await wait();
    assert.equal(user.nickname, undefined);
});

test('a property that ends up with its original value is not saved', async () => {
    const { listeners } = setup();
    const motor = createMotor();
    dx.PersistenceReactiveSetSource({ User: motor });
    const failed = [];
    dx.PersistenceReactive('User', {}, { notUpdated(props) { failed.push(props); } }, DELAY);
    const user = reactive({ name: 'A' }, listeners.User);
    user.name = 'B';
    user.name = 'A';
    await wait();
    assert.deepEqual(motor.calls, []);
    assert.deepEqual(failed, []);
});

test('failing hooks never affect persistence', async () => {
    const { listeners, logs } = setup();
    const motor = createMotor();
    dx.PersistenceReactiveSetSource({ User: motor });
    dx.PersistenceReactive('User', {}, {
        preUpdate() { throw new Error('preUpdate broke'); },
        updated() { throw new Error('updated broke'); }
    }, DELAY);
    const user = reactive({ name: 'A' }, listeners.User);
    user.name = 'B';
    await wait();
    assert.equal(user.name, 'B');
    assert.deepEqual(motor.calls, [['set', 'name', 'B'], ['save']]);
    assert.equal(warningsOf(logs).length, 2);
});

test('logs never contain the values being saved', async () => {
    const { listeners, logs } = setup();
    const motor = createMotor();
    dx.PersistenceReactiveSetSource({ User: motor });
    dx.PersistenceReactive('User', { password: async (value) => 'hashed:' + value.length }, {}, DELAY);
    const user = reactive({ password: '' }, listeners.User);
    user.password = 'secret-123';
    await wait();
    assert.equal(motor.calls[0][2], 'hashed:10');
    assert.ok(logs.length > 0);
    assert.equal(JSON.stringify(logs).includes('secret-123'), false);
});

test('without a persistence source it only warns', async () => {
    const { listeners, logs } = setup();
    const updated = [];
    dx.PersistenceReactive('Ghost', {}, { updated(saved) { updated.push(saved); } }, DELAY);
    const ghost = reactive({ name: 'A' }, listeners.Ghost);
    ghost.name = 'B';
    await wait();
    assert.deepEqual(updated, [['name']]);
    assert.equal(warningsOf(logs).length, 1);
});

test('an invalid persistence source fails the batch and rolls back', async () => {
    const { listeners, logs } = setup();
    dx.PersistenceReactiveSetSource({ User: {} });
    const failed = [];
    dx.PersistenceReactive('User', {}, { notUpdated(props) { failed.push(props); } }, DELAY);
    const user = reactive({ name: 'A' }, listeners.User);
    user.name = 'B';
    await wait();
    assert.equal(user.name, 'A');
    assert.deepEqual(failed, [['name']]);
    assert.equal(errorsOf(logs).length > 0, true);
});

test('the reactive callback rejects a missing "this"', () => {
    const { listeners, logs } = setup();
    dx.PersistenceReactive('User', {}, {}, DELAY);
    assert.equal(listeners.User.call(undefined, 'name', 'B'), false);
    assert.equal(errorsOf(logs).length, 1);
});

test('setters validate their arguments', () => {
    setup();
    assert.throws(() => dx.PersistenceReactiveSetFn(null), TypeError);
    assert.throws(() => dx.PersistenceFormSetFn('nope'), TypeError);
    assert.throws(() => dx.PersistenceInternalHandlerSet('Upload', {}), TypeError);
    assert.throws(() => dx.PersistenceReactiveSetSource(null), TypeError);
});

test('PersistenceReactive returns the unsubscribe function of the listener', () => {
    setup();
    const unsubscribe = () => 'bye';
    dx.PersistenceReactiveSetFn(() => unsubscribe);
    assert.equal(dx.PersistenceReactive('User'), unsubscribe);
    dx.PersistenceReactiveSetFn(() => undefined);
    assert.equal(dx.PersistenceReactive('User'), undefined);
});

test('PersistenceForm requires a target implementing set() and save()', () => {
    setup();
    assert.throws(() => dx.PersistenceForm({}), TypeError);
    assert.throws(() => dx.PersistenceForm({ target: { set() { } } }), TypeError);
    assert.doesNotThrow(() => dx.PersistenceForm({ target: createMotor() }));
});

test('PersistenceForm saves, runs hooks in order and survives a failing preMutation', async () => {
    setup();
    const motor = createMotor();
    const order = [];
    const form = dx.PersistenceForm({ target: motor }, {
        preMutation() { order.push('preMutation'); throw new Error('nope'); },
        postMutation() { order.push('postMutation'); },
        preUpdate() { order.push('preUpdate'); },
        updated() { order.push('updated'); }
    }, DELAY);
    const record = { title: 'A' };
    assert.equal(await mutateForm(form, record, 'title', 'B'), true);
    await wait();
    assert.deepEqual(order, ['preMutation', 'postMutation', 'preUpdate', 'updated']);
    assert.deepEqual(motor.calls, [['set', 'title', 'B'], ['save']]);
});

test('PersistenceForm keeps the order of edits when preMutation is slow', async () => {
    setup();
    const motor = createMotor();
    const durations = [30, 0];
    const form = dx.PersistenceForm({ target: motor }, {
        preMutation: () => new Promise((resolve) => setTimeout(resolve, durations.shift()))
    }, DELAY);
    const record = { title: 'A' };
    mutateForm(form, record, 'title', 'B');
    mutateForm(form, record, 'title', 'C');
    await wait(120);
    assert.equal(record.title, 'C');
    assert.deepEqual(motor.calls, [['set', 'title', 'C'], ['save']]);
});

test('PersistenceForm saves nested objects independently', async () => {
    setup();
    const motor = createMotor();
    const form = dx.PersistenceForm({ target: motor }, {}, DELAY);
    const root = { a: { n: 1 }, b: { n: 1 } };
    mutateForm(form, root.a, 'n', 2, root);
    mutateForm(form, root.b, 'n', 3, root);
    await wait();
    const sets = motor.calls.filter((call) => call[0] === 'set').map((call) => call[2]).sort();
    assert.deepEqual(sets, [2, 3]);
    assert.equal(motor.calls.filter((call) => call[0] === 'save').length, 2);
});

test('PersistenceForm rolls back when the target fails to save', async () => {
    setup();
    const motor = createMotor({ save: async () => { throw new Error('boom'); } });
    const failed = [];
    const form = dx.PersistenceForm({ target: motor }, { notUpdated(props) { failed.push(props); } }, DELAY);
    const record = { title: 'A' };
    mutateForm(form, record, 'title', 'B');
    await wait();
    assert.equal(record.title, 'A');
    assert.deepEqual(failed, [['title']]);
});
