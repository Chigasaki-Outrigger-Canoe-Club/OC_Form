// 選手の管理（ブラウザ内に保存）
// 保存形式：{ current: 選手ID, list: [{ id, name, values: { height, weight, paddle, bladeLength, bladeWidth } }] }
// 画面から分離した処理のみ。storage には localStorage（テストでは模擬オブジェクト）を渡す。

export const STORE_KEY = "oc-form-athletes";
const LEGACY_KEY = "oc-form-athlete"; // 選手管理を入れる前の保存（1人分）

const newId = () => `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export function loadStore(storage) {
  try {
    const store = JSON.parse(storage.getItem(STORE_KEY));
    if (store?.list?.length) return store;
    // 以前の1人分の保存があれば「選手1」として引き継ぐ
    const legacy = JSON.parse(storage.getItem(LEGACY_KEY));
    if (legacy) {
      const id = newId();
      return { current: id, list: [{ id, name: "選手1", values: legacy }] };
    }
  } catch {
    // 保存なし、または読めない
  }
  return { current: null, list: [] };
}

export function saveStore(storage, store) {
  try {
    storage.setItem(STORE_KEY, JSON.stringify(store));
    return true;
  } catch {
    return false; // 保存できない環境（プライベートモードなど）
  }
}

export const currentAthlete = (store) => store.list.find((a) => a.id === store.current) ?? null;

// 選手を追加して選択する。同じ名前がいれば追加せずその選手を選ぶ
export function addAthlete(store, name, values) {
  const trimmed = name.trim();
  if (!trimmed) return store;
  const same = store.list.find((a) => a.name === trimmed);
  if (same) return { ...store, current: same.id };
  const id = newId();
  return { current: id, list: [...store.list, { id, name: trimmed, values: { ...values } }] };
}

export function renameAthlete(store, id, name) {
  const trimmed = name.trim();
  if (!trimmed) return store;
  return { ...store, list: store.list.map((a) => (a.id === id ? { ...a, name: trimmed } : a)) };
}

export function removeAthlete(store, id) {
  const list = store.list.filter((a) => a.id !== id);
  return { current: list[0]?.id ?? null, list };
}

export function updateValues(store, values) {
  return { ...store, list: store.list.map((a) => (a.id === store.current ? { ...a, values: { ...values } } : a)) };
}

// バックアップ用のJSONを読み込む（形式が違えば例外）
export function parseBackup(text) {
  const json = JSON.parse(text);
  if (json.format !== "oc-form-athletes" || !Array.isArray(json.list)) {
    throw new Error("選手データのバックアップではありません");
  }
  return { current: json.current ?? json.list[0]?.id ?? null, list: json.list };
}

export const buildBackup = (store) => ({ format: "oc-form-athletes", version: 1, savedAt: new Date().toISOString(), ...store });

// 別の端末で保存した選手データ（GitHub）を合わせる：この端末にいない選手だけ追加する
// （この端末で入力した値は変えない。選手が誰もいなければ、保存されていた選択中の選手を選ぶ）
export function mergeAthletes(store, remote) {
  const missing = remote.list.filter((r) => !store.list.some((a) => a.id === r.id || a.name === r.name));
  if (!missing.length) return store;
  return { current: store.current ?? remote.current ?? missing[0].id, list: [...store.list, ...missing] };
}
