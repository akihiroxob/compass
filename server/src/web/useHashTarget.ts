import { useEffect } from "react";
import { useLocation } from "react-router-dom";

/** URLのhash（`#id`）が指す要素のid。空や不正なpercent-encoding（例 `#%`）は外部から入力できるため、例外にせず`null`にする。 */
export const hashTargetId = (hash: string): string | null => {
  if (hash.length <= 1) return null;
  try {
    return decodeURIComponent(hash.slice(1));
  } catch {
    return null;
  }
};

/**
 * URLのhash（`#id`）が指す要素へ、表示の準備ができてから移動してfocusする。非同期に読み込む一覧のanchor（別viewからのリンク）に使う。
 * 移動先は`tabIndex={-1}`でfocusできるようにしておく。不正なhashは無視する。
 */
export const useHashTarget = (ready: boolean) => {
  const { hash } = useLocation();
  useEffect(() => {
    if (!ready) return;
    const id = hashTargetId(hash);
    if (id === null) return;
    const target = document.getElementById(id);
    if (!target) return;
    target.scrollIntoView({ block: "start" });
    target.focus({ preventScroll: true });
  }, [ready, hash]);
};
