import { createRoot } from "react-dom/client";
import { App } from "./components/App.js";
import "./styles.css";

const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);
