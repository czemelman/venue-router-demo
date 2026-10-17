import "./monaco";
import "@gorules/jdm-editor/dist/style.css";
import { createRoot } from "react-dom/client";
import { JdmConfigProvider } from "@gorules/jdm-editor";
import { App } from "./App";

createRoot(document.getElementById("root")!).render(
  <JdmConfigProvider>
    <App />
  </JdmConfigProvider>,
);
