import type { Meta, StoryObj } from "@storybook/react-vite";
import { McpConnectionSection } from "./McpConnectionSection";

const meta = {
  title: "Patterns/McpConnection", component: McpConnectionSection, tags: ["autodocs"],
  args: { scope: { kind: "workspace", id: "workspace-example" }, workspaceId: "workspace-example", canManageCredentials: true, origin: "https://compass.example.test" },
} satisfies Meta<typeof McpConnectionSection>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Workspace: Story = {};
export const Project: Story = { args: { scope: { kind: "project", id: "project-example" } } };
export const Viewer: Story = { args: { canManageCredentials: false } };
