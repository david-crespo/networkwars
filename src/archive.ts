// Full-detail copies of the games trimOldest strips to fit localStorage, kept in
// IndexedDB for later analysis and written into the data export. Keyed by the
// round's index in the tally, which never changes because rounds are only
// appended. Nothing reads the archive at runtime except the export.
//
// Every call returns a promise that rejects on failure (missing IndexedDB, a
// failed open, or an aborted transaction) rather than throwing synchronously.
// Callers decide how to report errors.
import type { Round } from './types.ts';

const STORE = 'rounds';
let opened: Promise<IDBDatabase> | null = null;
/** Number of archivePut calls, to check whether an earlier read is stale. */
export let archiveWrites = 0;

function db() {
  return opened ??= new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open('nwArchive', 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      // Best effort: persistent storage makes the browser less likely to evict it.
      try { navigator.storage?.persist?.().catch(() => {}); } catch (_) {}
      const d = req.result;
      d.onclose = () => { opened = null; };
      resolve(d);
    };
  }).catch((e) => { opened = null; throw e; });
}

// Runs one transaction on the store. `body` queues requests and may pass a result
// to `done`; the returned promise resolves with that result once the transaction
// commits. Transactions run in call order.
function run<T>(mode: IDBTransactionMode, body: (store: IDBObjectStore, done: (v: T) => void) => void) {
  return db().then(d => new Promise<T>((resolve, reject) => {
    const t = d.transaction(STORE, mode);
    let out: T;
    t.oncomplete = () => resolve(out);
    t.onerror = t.onabort = () => reject(t.error ?? new Error('archive transaction aborted'));
    try { body(t.objectStore(STORE), v => { out = v; }); }
    catch (e) { t.abort(); throw e; }
  })).catch((e) => { if ((e as Error)?.name === 'InvalidStateError') opened = null; throw e; });
}

/**
 * Store a snapshot of round i. A lean snapshot (labels and history already
 * stripped) merges only its review and results into an existing record,
 * preserving the fuller copy archived when the round was made lean.
 */
export function archivePut(i: number, round: Round) {
  archiveWrites++;
  return run<void>('readwrite', store => {
    if (!round.lean) { store.put(round, i); return; }
    const get = store.get(i);
    get.onsuccess = () => {
      const rec: Round | undefined = get.result;
      if (rec) {
        if (round.you.review) rec.you.review = round.you.review;
        for (const s of ['you', 'ai'] as const) {
          const { result, forfeit, turns, red } = round[s];
          Object.assign(rec[s], { result, forfeit, turns, red });
        }
      }
      store.put(rec ?? round, i);
    };
  });
}

/** Every record, keyed by round index. */
export const archiveAll = () => run<Record<number, Round>>('readonly', (store, done) => {
  const keys = store.getAllKeys(), values = store.getAll();
  values.onsuccess = () => done(Object.fromEntries(keys.result.map((k, j) => [k, values.result[j]])));
});

/** Replace the whole archive, as an import does. Keys that are not round indices are skipped. */
export const archiveReplace = (records: Record<string, Round>) => run<void>('readwrite', store => {
  store.clear();
  for (const [k, r] of Object.entries(records)) if (Number.isInteger(+k) && +k >= 0) store.put(r, +k);
});
