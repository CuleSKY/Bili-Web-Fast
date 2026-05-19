import React from "react";
import ReactDOM from "react-dom/client";
import "../shared/styles.css";
import { PopupApp } from "./ui";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <PopupApp />
  </React.StrictMode>,
);
