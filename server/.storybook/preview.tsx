import type { Preview } from "@storybook/react-vite";
import { MemoryRouter } from "react-router-dom";
import "../src/web/app/main.scss";

const preview: Preview = {
  decorators: [(Story) => <MemoryRouter><Story /></MemoryRouter>],
  parameters: {
    layout: "padded",
    options: { storySort: { order: ["Foundations", "Components", "Patterns"] } },
    docs: { codePanel: true },
  },
};
export default preview;
