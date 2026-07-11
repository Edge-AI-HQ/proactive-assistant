import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
// 注入 @pin-ai/core 的 transport 配置（auth/baseUrl/平台 headers）——
// ui-web 的 transport-bootstrap 在模块加载时 configureTransport（web 介质
// 下 apps/web 与 proactive-ai-frontend 共用同一份组装，见 ui-web）。
import "@/ui-web";
import { queryClient } from "./lib/query-client";
import App from "./App";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
