import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { IntentCreatePage, IntentDetailPage, IntentEditPage } from "./features/intent";
import { OutcomeCreatePage, OutcomeDetailPage, OutcomeEditPage } from "./features/outcome";
import { ProjectCreatePage, ProjectDetailPage, ProjectEditPage, ProjectListPage } from "./features/project";
import { ResearchRequestDetailPage } from "./features/research";
import "./styles.css";

const App = () => <Routes><Route path="/" element={<ProjectListPage />} /><Route path="/projects/new" element={<ProjectCreatePage />} /><Route path="/projects/:projectId" element={<ProjectDetailPage />} /><Route path="/projects/:projectId/edit" element={<ProjectEditPage />} /><Route path="/projects/:projectId/intents/new" element={<IntentCreatePage />} /><Route path="/projects/:projectId/intents/:intentId" element={<IntentDetailPage />} /><Route path="/projects/:projectId/intents/:intentId/edit" element={<IntentEditPage />} /><Route path="/projects/:projectId/intents/:intentId/outcomes/new" element={<OutcomeCreatePage />} /><Route path="/projects/:projectId/intents/:intentId/outcomes/:outcomeId" element={<OutcomeDetailPage />} /><Route path="/projects/:projectId/intents/:intentId/outcomes/:outcomeId/edit" element={<OutcomeEditPage />} /><Route path="/projects/:projectId/research/:requestId" element={<ResearchRequestDetailPage />} /></Routes>;
createRoot(document.getElementById("root")!).render(<StrictMode><BrowserRouter><App /></BrowserRouter></StrictMode>);
