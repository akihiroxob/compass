import { Navigate, useParams } from "react-router-dom";
import { projectViewPath } from "../../paths";

/** Projectの編集はProject設定内で行う。旧編集URLは設定へ移す。 */
export const ProjectEditPage = () => { const { projectId = "" } = useParams(); return <Navigate to={projectViewPath(projectId, "settings")} replace />; };
