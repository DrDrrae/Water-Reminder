import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./App.css";

// Mount the React application into the #root element defined in index.html.
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
