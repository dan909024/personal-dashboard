import type { Metadata } from "next";
import { Inter, Fraunces } from "next/font/google";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-sans" });
const fraunces = Fraunces({
  subsets: ["latin"],
  variable: "--font-serif",
  axes: ["SOFT", "opsz"],
});

export const metadata: Metadata = {
  title: "Coach Harley · Dashboard",
  description: "Roses and iron.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`h-full ${inter.variable} ${fraunces.variable}`}>
      <body className={`${inter.className} min-h-full bg-ink text-ivory-50 antialiased`}>
        {children}
      </body>
    </html>
  );
}
