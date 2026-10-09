import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { NotFoundPage } from "./components/NotFoundPage";
import { AuthGate, InvitePage, LoginPage } from "./features/auth";
import { StoryCreatePage, StoryEditPage, TaskCreatePage, TaskDetailPage, TaskEditPage } from "./features/execution";
import { IntentCreatePage, IntentDetailPage, IntentEditPage } from "./features/intent";
import { OutcomeCreatePage, OutcomeDetailPage, OutcomeEditPage } from "./features/outcome";
import { ProjectCreatePage, ProjectDetailPage, ProjectEditPage, ProjectListPage } from "./features/project";
import { ResearchRequestDetailPage } from "./features/research";
import { WorkspaceActivityPage, WorkspaceAgentsPage, WorkspaceDirectionPage, WorkspaceHomePage, WorkspaceNavigationProvider, WorkspaceOverviewPage, WorkspaceProjectsPage } from "./features/workspace";
import "./styles/main.scss";

const AppRoutes = () => <Routes><Route path="/" element={<WorkspaceHomePage />} /><Route path="/workspaces/:workspaceId" element={<WorkspaceOverviewPage />} /><Route path="/workspaces/:workspaceId/direction" element={<WorkspaceDirectionPage />} /><Route path="/workspaces/:workspaceId/projects" element={<WorkspaceProjectsPage />} /><Route path="/workspaces/:workspaceId/activity" element={<WorkspaceActivityPage />} /><Route path="/workspaces/:workspaceId/agents" element={<WorkspaceAgentsPage />} /><Route path="/projects" element={<ProjectListPage />} /><Route path="/projects/new" element={<ProjectCreatePage />} /><Route path="/projects/:projectId" element={<ProjectDetailPage />} /><Route path="/projects/:projectId/edit" element={<ProjectEditPage />} /><Route path="/projects/:projectId/intents/new" element={<IntentCreatePage />} /><Route path="/projects/:projectId/intents/:intentId" element={<IntentDetailPage />} /><Route path="/projects/:projectId/intents/:intentId/edit" element={<IntentEditPage />} /><Route path="/projects/:projectId/intents/:intentId/outcomes/new" element={<OutcomeCreatePage />} /><Route path="/projects/:projectId/intents/:intentId/outcomes/:outcomeId" element={<OutcomeDetailPage />} /><Route path="/projects/:projectId/intents/:intentId/outcomes/:outcomeId/edit" element={<OutcomeEditPage />} /><Route path="/projects/:projectId/research/:requestId" element={<ResearchRequestDetailPage />} /><Route path="/projects/:projectId/stories/new" element={<StoryCreatePage />} /><Route path="/projects/:projectId/stories/:storyId/edit" element={<StoryEditPage />} /><Route path="/projects/:projectId/tasks/new" element={<TaskCreatePage />} /><Route path="/projects/:projectId/tasks/:taskId" element={<TaskDetailPage />} /><Route path="/projects/:projectId/tasks/:taskId/edit" element={<TaskEditPage />} /><Route path="*" element={<NotFoundPage />} /></Routes>;
// ログイン画面・招待画面だけSession無しで開ける。それ以外はAuthGateがSessionを復元してから描画し、Shellへ現在のWorkspaceを渡す。
const App = () => <Routes><Route path="/login" element={<LoginPage />} /><Route path="/invite" element={<InvitePage />} /><Route path="*" element={<AuthGate><WorkspaceNavigationProvider><AppRoutes /></WorkspaceNavigationProvider></AuthGate>} /></Routes>;
createRoot(document.getElementById("root")!).render(<StrictMode><BrowserRouter><App /></BrowserRouter></StrictMode>);
