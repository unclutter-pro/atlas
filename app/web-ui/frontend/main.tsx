// Global styles first so area stylesheets (imported by pages) come later in the cascade.
import "./styles.css";
import { createRoot } from "react-dom/client";
import { App } from "./App";

createRoot(document.getElementById("root")!).render(<App />);
