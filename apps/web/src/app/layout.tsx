import type { Metadata } from "next";
import type { ReactNode } from "react";
import { GeistSans } from "geist/font/sans";

import "@fontsource-variable/noto-serif-sc/wght.css";

import { THEME_BOOTSTRAP_SCRIPT } from "@/features/theme/theme-preference";

import "@/styles/globals.css";
import "@/styles/workspace.css";

export const metadata: Metadata = {
  title: "NewDay · 今天要做的事",
  description: "一个简洁、本地优先的每日任务清单。",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="zh-CN"
      data-theme="light"
      suppressHydrationWarning
      className={`${GeistSans.variable} h-full antialiased`}
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP_SCRIPT }} />
      </head>
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
