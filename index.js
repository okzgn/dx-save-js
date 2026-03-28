const debounces = Object.create(null);
function debounce(id, callback, delay = 2000) {
    clearTimeout(debounces[id]);
    debounces[id] = setTimeout(function () {
        delete debounces[id];
        callback();
    }, delay);
}
let PersistenceReactiveFn = function () { throw new Error('DX Save: initialize with PersistenceReactiveSetFn(fn)'); };
export function PersistenceReactiveSetFn(fn) { PersistenceReactiveFn = fn; }
let PersistenceReactiveSource = {};
export function PersistenceReactiveSetSource(source) { PersistenceReactiveSource = source; }
export function PersistenceReactive(className, handlers = {}, hooks = {}) {
    let saveIntents = {};
    PersistenceReactiveFn(className, function (property, value) {
        if (this.__isSystemRollback) {
            return true;
        }
        try {
            saveIntents[property] = saveIntents[property] || {};
            saveIntents[property].value = value;
            if (typeof saveIntents[property].previousValue === 'undefined') {
                saveIntents[property].previousValue = this[property];
            }
            debounce(className + '-saveAllIntents', async () => {
                const intentsCopy = Object.assign(Object.create(null), saveIntents);
                saveIntents = {};
                await PersistenceInternalHandler(intentsCopy, PersistenceReactiveSource[className], this, handlers, hooks);
            });
        }
        catch (e) {
            console.error('PersistenceReactive error:', e.message);
            saveIntents = {};
            return false;
        }
        return true;
    });
}
let PersistenceInternalHandlers = {
    'Upload': async function () { throw new Error('DX Save: initialize with PersistenceInternalHandlerSet("Upload", fn)'); }
};
export function PersistenceInternalHandlerSet(handler, fn) { PersistenceInternalHandlers[handler] = fn; }
async function PersistenceInternalHandler(saveIntents, persistenceMotorObject, object, handlers = {}, hooks = {}) {
    var _a, _b, _c, _d, _e;
    console.info('Save intent:', saveIntents);
    let persistenceMotorObjectIsObject = persistenceMotorObject && typeof persistenceMotorObject === 'object';
    let persistenceMotorObjectIsCustom = persistenceMotorObjectIsObject && typeof (persistenceMotorObject === null || persistenceMotorObject === void 0 ? void 0 : persistenceMotorObject.upload) === 'function' && typeof (persistenceMotorObject === null || persistenceMotorObject === void 0 ? void 0 : persistenceMotorObject.set) === 'function' && typeof (persistenceMotorObject === null || persistenceMotorObject === void 0 ? void 0 : persistenceMotorObject.save) === 'function';
    let toSave = [];
    let notToSave = [];
    for (let property of Object.keys(saveIntents)) {
        let saveIntent = saveIntents[property];
        let saveIntentIsObject = saveIntent.previousValue && typeof saveIntent.previousValue === 'object' && saveIntent.value && typeof saveIntent.value === 'object';
        let isCapableToSave = saveIntentIsObject ? true : saveIntent.previousValue !== saveIntent.value;
        if (isCapableToSave) {
            for (let handlerProperty of Object.keys(handlers)) {
                let handler = handlers[handlerProperty];
                let handlerIsFn = typeof handler === 'function';
                let handlerIsObj = typeof handler === 'object';
                if (!handler || (!handlerIsFn && !handlerIsObj)) {
                    continue;
                }
                if (handlerProperty === property && handlerIsFn) {
                    try {
                        console.info('"' + handlerProperty + '" handler:', saveIntent.value, saveIntent.previousValue);
                        let handlerResponse = await handler(saveIntent.value, saveIntent.previousValue, saveIntent);
                        saveIntent.value = handlerResponse;
                    }
                    catch (e) {
                        console.error('"' + handlerProperty + '" handler error:', e.message);
                        isCapableToSave = false;
                    }
                    break;
                }
                else if (handlerProperty === 'images' && handlerIsObj && ((_a = handler === null || handler === void 0 ? void 0 : handler.properties) === null || _a === void 0 ? void 0 : _a.includes(property))) {
                    try {
                        console.info('File save intent:', property, saveIntent.value);
                        let imgFormat = saveIntent.value.format;
                        let imgPath = saveIntent.value.webPath;
                        let blob;
                        if (((_b = saveIntent.value) === null || _b === void 0 ? void 0 : _b.webPath) && ((_c = saveIntent.value) === null || _c === void 0 ? void 0 : _c.format)) {
                            let img = await fetch(imgPath);
                            blob = await img.blob();
                        }
                        else if (((_d = saveIntent.value) === null || _d === void 0 ? void 0 : _d.files) && ((_e = saveIntent.value.files) === null || _e === void 0 ? void 0 : _e.length) && saveIntent.value.files[0].name && saveIntent.value.files[0].size) {
                            blob = saveIntent.value.files[0];
                        }
                        else {
                            throw new Error('File is incompatible for uploading.');
                        }
                        saveIntent.value = persistenceMotorObjectIsCustom ? await persistenceMotorObjectIsCustom.upload(blob, imgFormat, property) : await PersistenceInternalHandlers.Upload((property + '.' + imgFormat), blob);
                        console.info('Upload result:', property, saveIntent.value);
                        saveIntent.maskValue = { url: imgPath };
                    }
                    catch (e) {
                        console.error('File save intent error:', e.message);
                        isCapableToSave = false;
                    }
                    break;
                }
            }
        }
        if (isCapableToSave) {
            object[property] = saveIntent.maskValue || saveIntent.value;
            try {
                if (persistenceMotorObjectIsObject) {
                    persistenceMotorObject.set(property, saveIntent.value);
                }
                toSave.push(property);
            }
            catch (e) {
                console.error('Persistence motor set error:', e.message);
                notToSave.push(property);
            }
        }
        else {
            notToSave.push(property);
        }
    }
    try {
        if (typeof hooks['preUpdate'] === 'function') {
            hooks['preUpdate'].call(object, toSave, notToSave);
        }
        if (toSave.length) {
            if (persistenceMotorObjectIsObject) {
                await persistenceMotorObject.save();
            }
            console.info('Values updated:', toSave);
            if (typeof hooks['updated'] === 'function') {
                try {
                    hooks['updated'].call(object, toSave, Object.assign({}, saveIntents));
                }
                catch (e) {
                    console.warn('Updated hook failed.');
                }
            }
        }
    }
    catch (e) {
        console.error('Persistence motor save error:', e.message);
        notToSave = toSave.concat(notToSave);
        toSave = [];
    }
    try {
        if (notToSave.length) {
            console.warn('Values NOT updated:', notToSave);
            Object.defineProperty(object, '__isSystemRollback', {
                value: true,
                writable: true,
                enumerable: false,
                configurable: true
            });
            for (let failedProperty of notToSave) {
                object[failedProperty] = saveIntents[failedProperty].previousValue;
            }
            delete object.__isSystemRollback;
            if (typeof hooks['notUpdated'] === 'function') {
                hooks['notUpdated'].call(object, notToSave, Object.assign({}, saveIntents));
            }
        }
    }
    catch (e) {
        console.error('Persistence motor regenerate error:', e.message);
    }
}
const persistenceIntents = {};
async function PersistenceHandler(id, property, value, object, root, persistenceLogic, delay = 2000) {
    try {
        persistenceIntents[id] = persistenceIntents[id] || {};
        persistenceIntents[id][property] = persistenceIntents[id][property] || {};
        persistenceIntents[id][property].value = value;
        if (typeof persistenceIntents[id][property].previousValue === 'undefined') {
            persistenceIntents[id][property].previousValue = object[property];
        }
        debounce(id + '-persistenceAllIntents', async () => {
            //console.info('Persistence intent:', persistenceIntents[id]);
            const intentsCopy = Object.assign(Object.create(null), persistenceIntents[id]);
            delete persistenceIntents[id];
            await persistenceLogic.call(intentsCopy, property, value, object, root);
        }, delay);
    }
    catch (e) {
        console.error('PersistenceHandler error:', e.message);
        delete persistenceIntents[id];
        return false;
    }
    return true;
}
let PersistenceFormFn = function () { throw new Error('DX Save: initialize with PersistenceFormSetFn(fn)'); };
export function PersistenceFormSetFn(fn) { PersistenceFormFn = fn; }
export function PersistenceForm(handlers = {}, hooks = {}, delay = 2000) {
    const id = ('persistenceForm-' + Date.now() + '-' + Math.round(Math.random() * 1234567890));
    const persistenceForm = PersistenceFormFn(async function (property, value, object, root) {
        if (object.__isSystemRollback || root.__isSystemRollback) {
            return true;
        }
        if (typeof hooks['preMutation'] === 'function') {
            await hooks['preMutation'].call(persistenceForm, property, value, object, root);
        }
        const persistenceHandlerReturn = await PersistenceHandler(id, property, value, object, root, async function () {
            try {
                await PersistenceInternalHandler(this, handlers['target'], object, handlers, hooks);
            }
            catch (e) {
                console.error('PersistenceForm error:', e.message);
                return false;
            }
            return true;
        }, delay);
        if (typeof hooks['postMutation'] === 'function') {
            await hooks['postMutation'].call(persistenceForm, property, value, object, root);
        }
        return persistenceHandlerReturn;
    });
    return persistenceForm;
}