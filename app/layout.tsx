import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Interview Room",
  description: "A simple video interview room.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
