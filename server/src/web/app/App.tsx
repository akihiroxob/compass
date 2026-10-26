import { Route, Routes } from "react-router-dom";
import { InvitePage, LoginPage } from "../features/auth";
import { ConsultationDetailPage, ConsultationInboxPage } from "../features/consultation";
import { StoryCreatePage, StoryEditPage, TaskCreatePage, TaskDetailPage, TaskEditPage } from "../features/execution";
import { IntentCreatePage, IntentDetailPage, IntentEditPage } from "../features/intent";
import { OutcomeCreatePage, OutcomeDetailPage, OutcomeEditPage } from "../features/outcome";
import { ProjectDetailPage, ProjectEditPage, ProjectListPage } from "../features/project";
import { ResearchRequestDetailPage } from "../features/research";
import { WorkspaceActivityPage, WorkspaceAgentsPage, WorkspaceBreadcrumbItems, WorkspaceConsultationsPage, WorkspaceCreatePage, WorkspaceDirectionPage, WorkspaceEditPage, WorkspaceHomePage, WorkspaceOutcomePage, WorkspaceOverviewPage, WorkspaceProjectCreatePage, WorkspaceProjectsPage, WorkspaceSettingsPage } from "../features/workspace";
import { AuthenticatedLayout, PublicLayout } from "./AppLayout";
import { NotFoundPage } from "./NotFoundPage";

/** Task詳細のパンくずへ、workspaceが持つ現在のWorkspaceの項目を合成する。 */
const TaskDetailRoute = () => <TaskDetailPage workspaceCrumbs={(project) => <WorkspaceBreadcrumbItems project={project} />} />;

/** routing。ログイン画面・招待画面だけSession無しで開け、それ以外（未定義のURLを含む）はログイン後のlayoutで描画する。 */
export const App = () => (
  <Routes>
    <Route element={<PublicLayout />}>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/invite" element={<InvitePage />} />
    </Route>
    <Route element={<AuthenticatedLayout />}>
      <Route path="/" element={<WorkspaceHomePage />} />
      <Route path="/workspaces/new" element={<WorkspaceCreatePage />} />
      <Route path="/workspaces/:workspaceId" element={<WorkspaceOverviewPage />} />
      <Route path="/workspaces/:workspaceId/edit" element={<WorkspaceEditPage />} />
      <Route path="/workspaces/:workspaceId/direction" element={<WorkspaceDirectionPage />} />
      <Route path="/workspaces/:workspaceId/direction/intents/:intentId/outcomes/:outcomeId" element={<WorkspaceOutcomePage />} />
      <Route path="/workspaces/:workspaceId/consultations" element={<WorkspaceConsultationsPage />} />
      <Route path="/workspaces/:workspaceId/consultations/:consultationId" element={<ConsultationDetailPage />} />
      <Route path="/workspaces/:workspaceId/projects" element={<WorkspaceProjectsPage />} />
      <Route path="/workspaces/:workspaceId/projects/new" element={<WorkspaceProjectCreatePage />} />
      <Route path="/workspaces/:workspaceId/activity" element={<WorkspaceActivityPage />} />
      <Route path="/workspaces/:workspaceId/agents" element={<WorkspaceAgentsPage />} />
      <Route path="/workspaces/:workspaceId/settings" element={<WorkspaceSettingsPage />} />
      <Route path="/consultations" element={<ConsultationInboxPage />} />
      <Route path="/projects" element={<ProjectListPage />} />
      <Route path="/projects/:projectId" element={<ProjectDetailPage />} />
      <Route path="/projects/:projectId/edit" element={<ProjectEditPage />} />
      <Route path="/projects/:projectId/intents/new" element={<IntentCreatePage />} />
      <Route path="/projects/:projectId/intents/:intentId" element={<IntentDetailPage />} />
      <Route path="/projects/:projectId/intents/:intentId/edit" element={<IntentEditPage />} />
      <Route path="/projects/:projectId/intents/:intentId/outcomes/new" element={<OutcomeCreatePage />} />
      <Route path="/projects/:projectId/intents/:intentId/outcomes/:outcomeId" element={<OutcomeDetailPage />} />
      <Route path="/projects/:projectId/intents/:intentId/outcomes/:outcomeId/edit" element={<OutcomeEditPage />} />
      <Route path="/projects/:projectId/research/:requestId" element={<ResearchRequestDetailPage />} />
      <Route path="/projects/:projectId/consultations/:consultationId" element={<ConsultationDetailPage />} />
      <Route path="/projects/:projectId/stories/new" element={<StoryCreatePage />} />
      <Route path="/projects/:projectId/stories/:storyId/edit" element={<StoryEditPage />} />
      <Route path="/projects/:projectId/tasks/new" element={<TaskCreatePage />} />
      <Route path="/projects/:projectId/tasks/:taskId" element={<TaskDetailRoute />} />
      <Route path="/projects/:projectId/tasks/:taskId/edit" element={<TaskEditPage />} />
      <Route path="*" element={<NotFoundPage />} />
    </Route>
  </Routes>
);
