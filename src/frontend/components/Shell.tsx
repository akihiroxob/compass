import type { ReactNode } from "react";
import { Link } from "react-router-dom";

export const Shell = ({ children }: { children: ReactNode }) => (
  <>
    <header className="site-header">
      <Link to="/" className="brand">
        <span>◒</span> Compass
      </Link>
      <p>Direction workspace</p>
    </header>
    {children}
  </>
);
