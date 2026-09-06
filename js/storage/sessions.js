// storage/sessions.js — セッションの永続化（IndexedDB）。
// ターン確定・要約確定・状態遷移・離脱のたびに put する（BD §8.1）。

const DB_NAME = "aigiron";
const DB_VERSION = 1;
const STORE = "sessions";

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    // indexedDB プロパティの参照自体が投げる環境がある（ストレージを拒否する設定など）
    let req;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (e) {
      reject(e);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id" }).createIndex("updatedAt", "updatedAt");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error("別のタブが古いバージョンのDBを開いています"));
  });
  // 失敗した Promise をキャッシュに残すと、一度きりの失敗で以後ずっと保存できなくなる。
  // 次の呼び出しで開き直せるように捨てる（D-057）。
  dbPromise.catch(() => { dbPromise = null; });
  return dbPromise;
}

function tx(mode, fn) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    let result;
    try { result = fn(store); } catch (e) { reject(e); return; }
    // fn が IDBRequest を返したら中身を取り出す。delete 後の get は undefined → null に揃える
    t.oncomplete = () => {
      const isReq = result && typeof result === "object" && "readyState" in result;
      resolve(isReq ? (result.result ?? null) : result);
    };
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

// 保存対象は素のオブジェクトに限る。関数やDOMが混ざると structured clone で落ちる。
function plain(session) {
  return JSON.parse(JSON.stringify(session));
}

export const sessionsStorage = {
  async save(session) {
    await tx("readwrite", (st) => st.put(plain(session)));
  },

  async get(id) {
    const r = await tx("readonly", (st) => st.get(id));
    return r ?? null;
  },

  // updatedAt 降順
  async list() {
    const all = await tx("readonly", (st) => st.getAll());
    return (all ?? []).sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  },

  async remove(id) {
    await tx("readwrite", (st) => st.delete(id));
  },

  // 再開候補。running / waiting / paused のまま残っているもの（BD §8.2）
  async findUnfinished() {
    const all = await this.list();
    return all.find((s) => s.status === "running" || s.status === "waiting" || s.status === "paused") ?? null;
  },

  // テスト用
  async clearAll() {
    await tx("readwrite", (st) => st.clear());
  }
};
