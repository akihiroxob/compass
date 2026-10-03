import { useEffect } from "react";
import { useLocation } from "react-router-dom";

/**
 * URLのhash（`#id`）が指す要素へ、表示の準備ができてから移動してfocusする。非同期に読み込む一覧のanchor（別viewからのリンク）に使う。
 * 移動先は`tabIndex={-1}`でfocusできるようにしておく。
 */
export const useHashTarget = (ready: boolean) => {
  const { hash } = useLocation();
  useEffect(() => {
    if (!ready || !hash) return;
    const target = document.getElementById(decodeURIComponent(hash.slice(1)));
    if (!target) return;
    target.scrollIntoView({ block: "start" });
    target.focus({ preventScroll: true });
  }, [ready, hash]);
};
