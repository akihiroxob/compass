import type { ReactNode } from "react";

/**
 * 画面の本文の2列（主列と補助列）。主列に次の行動・現在地・履歴など判断に使う区画を、補助列に境界・件数・担当などの参照を置く。
 * 列の中の区画の間隔はこの部品が持ち、区画は外側余白を持たない。狭い画面は1列で、`sideFirst`なら補助列を先に積む（例: Task詳細の担当）。
 */
export const PageColumns = ({ main, side, sideFirst = false }: { main: ReactNode; side: ReactNode; sideFirst?: boolean }) => {
  const mainColumn = <div className="page-main">{main}</div>;
  const sideColumn = <div className="page-side">{side}</div>;
  return <div className="page-columns">{sideFirst ? <>{sideColumn}{mainColumn}</> : <>{mainColumn}{sideColumn}</>}</div>;
};
